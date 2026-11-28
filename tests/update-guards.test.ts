import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateGuards } from '../web/src/updateGuards';
test('update guard reads current reasons and disposal removes only the owning feature', () => {
  const registry = createUpdateGuards();
  let draft = true;
  const closeEditor = registry.register(() => (draft ? '批注尚未保存' : undefined));
  const stopChat = registry.register(() => '七七正在回答');
  assert.deepEqual(registry.reasons(), ['批注尚未保存', '七七正在回答']);
  draft = false;
  assert.deepEqual(registry.reasons(), ['七七正在回答']);
  closeEditor();
  assert.deepEqual(registry.reasons(), ['七七正在回答']);
  stopChat();
  assert.deepEqual(registry.reasons(), []);
});
test('legacy cancelable update event shares the registry and ref-counts attachments', () => {
  const target = new EventTarget();
  const registry = createUpdateGuards();
  const detachA = registry.attach(target),
    detachB = registry.attach(target);
  const release = registry.register(() => '七七的消息需发送或清空');
  const allowed = () =>
    target.dispatchEvent(new Event('codesip:before-update', { cancelable: true }));
  assert.equal(allowed(), false);
  detachA();
  detachA();
  assert.equal(allowed(), false);
  release();
  assert.equal(allowed(), true);
  registry.register(() => 'another editor');
  detachB();
  assert.equal(allowed(), true);
});
test('two instances with the same reason remain protected independently', () => {
  const registry = createUpdateGuards();
  const getter = () => '文档未保存';
  const first = registry.register(getter),
    second = registry.register(getter);
  assert.deepEqual(registry.reasons(), ['文档未保存']);
  first();
  assert.deepEqual(registry.reasons(), ['文档未保存']);
  second();
  assert.deepEqual(registry.reasons(), []);
});
