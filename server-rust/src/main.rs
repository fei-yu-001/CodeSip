mod db;
mod error;
mod files;
mod http;
mod reader;
mod sync;

use std::sync::Arc;
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--check-database") {
        let filename = std::env::args().nth(2).ok_or("Database path required")?;
        let pool = db::Pool::open(&filename).map_err(|_| "Database validation failed")?;
        let connection = pool.get();
        let check: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" || connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err("Database integrity validation failed".into());
        }
        println!("{{\"status\":\"ok\",\"runtime\":\"rust\"}}");
        return Ok(());
    }
    let production = std::env::var("NODE_ENV").as_deref() == Ok("production");
    let setup = std::env::var("CODESIP_SETUP_TOKEN").unwrap_or_else(|_| {
        if production {
            String::new()
        } else {
            "codesip-local-development-only".into()
        }
    });
    if setup.len() < 16 {
        return Err("CODESIP_SETUP_TOKEN must contain at least 16 characters".into());
    }
    let filename = std::env::var("CODESIP_DB").unwrap_or_else(|_| ".local/codesip.sqlite".into());
    let pool = db::Pool::open(&filename).map_err(|_| "Could not initialize CodeSip database")?;
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "4318".into())
        .parse::<u16>()?;
    let public =
        std::env::var("CODESIP_PUBLIC_URL").unwrap_or_else(|_| "http://127.0.0.1:4318".into());
    let mut origins = vec![url::Url::parse(&public)?.origin().ascii_serialization()];
    if !production {
        origins.extend(
            [
                "http://127.0.0.1:5173",
                "http://localhost:5173",
                "http://127.0.0.1:4318",
                "http://localhost:4318",
            ]
            .map(String::from),
        );
    }
    let state = Arc::new(http::State {
        pool,
        setup,
        production,
        origins,
        static_dir: std::env::var("CODESIP_STATIC_DIR").unwrap_or_else(|_| "dist/web".into()),
        jobs: Arc::new(tokio::sync::Semaphore::new(4)),
        uploads: Arc::new(tokio::sync::Semaphore::new(1)),
        rates: std::sync::Mutex::new(std::collections::HashMap::new()),
        rate_limit: production || std::env::var("CODESIP_RATE_LIMIT").as_deref() != Ok("off"),
    });
    let app = axum::Router::new()
        .fallback(http::handler)
        .with_state(state);
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    eprintln!("CodeSip Rust listening on {}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=term.recv()=>{} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
