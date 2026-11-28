#!/usr/bin/env python3
"""Compare real HTTP reads using synthetic data; never opens a user's database."""
import argparse, base64, concurrent.futures, contextlib, gzip, hashlib, http.client, json, os
import pathlib, socket, statistics, subprocess, tempfile, time

parser = argparse.ArgumentParser()
parser.add_argument('--node-entry', required=True)
parser.add_argument('--rust-binary', required=True)
args = parser.parse_args()
content = ''.join('## Synthetic section %d\n\nRead-only example %s\n\n' % (i, hashlib.sha256(str(i).encode()).hexdigest()) for i in range(7000)).encode()[:641620]
expected_hash = hashlib.sha256(content).hexdigest()

def sample(command, label, folder):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = 'http://127.0.0.1:' + str(port)
    env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), NODE_ENV='test',
               CODESIP_DB=str(folder / (label + '.sqlite')), CODESIP_PUBLIC_URL=origin,
               CODESIP_SETUP_TOKEN='synthetic-benchmark-setup', CODESIP_RATE_LIMIT='off')
    process = subprocess.Popen(command, env=env, cwd=folder, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def call(method, path, body=None, cookie='', connection=None):
        own = connection is None
        connection = connection or http.client.HTTPConnection('127.0.0.1', port, timeout=30)
        headers = {'Origin': origin, 'Cookie': cookie, 'Accept-Encoding': 'gzip'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body).encode()
        start = time.perf_counter()
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
        elapsed = (time.perf_counter() - start) * 1000
        status, result_headers = response.status, {key.lower(): value for key, value in response.getheaders()}
        if own:
            connection.close()
        if status != 200:
            raise RuntimeError(label + ' synthetic HTTP request failed: ' + str(status))
        decoded = gzip.decompress(data) if result_headers.get('content-encoding') == 'gzip' else data
        return decoded, result_headers, elapsed, len(data)
    try:
        for _ in range(100):
            try:
                health = json.loads(call('GET', '/api/health')[0])
                break
            except Exception:
                if process.poll() is not None:
                    raise RuntimeError(label + ' failed to start')
                time.sleep(.1)
        else:
            raise RuntimeError(label + ' startup timeout')
        if label == 'rust' and health.get('runtime') != 'rust':
            raise RuntimeError('Benchmark did not reach Rust')
        _, headers, _, _ = call('POST', '/api/auth/setup', {'username': 'synthetic', 'password': 'synthetic-benchmark-password', 'setupToken': 'synthetic-benchmark-setup'})
        cookie = headers['set-cookie'].split(';')[0]
        created = json.loads(call('POST', '/api/libraries', {'name': 'Synthetic benchmark', 'kind': 'notes'}, cookie)[0])
        library = created['library']['id']
        upserts = [{'path': 'long.md', 'content': base64.b64encode(content).decode()}]
        upserts += [{'path': 'notes/%d.md' % i, 'content': base64.b64encode(('Synthetic note %d' % i).encode()).decode()} for i in range(99)]
        call('POST', '/api/libraries/' + library + '/sync', {'baseRevision': 0, 'deleted': [], 'upserts': upserts}, cookie)
        file_path = '/api/libraries/' + library + '/file?path=long.md'
        manifest_path = '/api/libraries/' + library + '/manifest'
        def summarize(values):
            values = sorted(values)
            return {'median_ms': round(statistics.median(values), 3), 'p95_ms': round(values[int((len(values)-1)*.95)], 3)}
        def read_file(connection=None):
            data, _, elapsed, wire = call('GET', file_path, cookie=cookie, connection=connection)
            if hashlib.sha256(data).hexdigest() != expected_hash:
                raise RuntimeError('Read changed synthetic content')
            return elapsed, wire
        with contextlib.closing(http.client.HTTPConnection('127.0.0.1', port, timeout=30)) as connection:
            for _ in range(15): read_file(connection)
            file_samples = [read_file(connection) for _ in range(60)]
            manifest_samples = [call('GET', manifest_path, cookie=cookie, connection=connection)[2] for _ in range(60)]
        start = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            parallel = list(pool.map(lambda _: read_file()[0], range(60)))
        duration = time.perf_counter() - start
        status = pathlib.Path('/proc/%d/status' % process.pid).read_text()
        rss_kib = int(next(line.split()[1] for line in status.splitlines() if line.startswith('VmRSS:')))
        return {'runtime': label, 'source_bytes': len(content), 'gzip_bytes': file_samples[0][1],
                'file_sequential': summarize([s[0] for s in file_samples]), 'manifest_sequential': summarize(manifest_samples),
                'file_concurrent_6': summarize(parallel), 'concurrent_reads_per_second': round(60/duration, 2),
                'warm_rss_mib': round(rss_kib/1024, 2), 'successful_reads': 195, 'health': health}
    finally:
        process.terminate()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired: process.kill(); process.wait()

with tempfile.TemporaryDirectory(prefix='codesip-synthetic-benchmark-') as directory:
    folder = pathlib.Path(directory)
    result = [sample(['node', str(pathlib.Path(args.node_entry).resolve())], 'node', folder),
              sample([str(pathlib.Path(args.rust_binary).resolve())], 'rust', folder)]
    print(json.dumps({'environment': 'Linux loopback; synthetic data; no production CPU quota; sequential Node then Rust', 'results': result}, indent=2))
