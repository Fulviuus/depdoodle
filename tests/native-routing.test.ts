// @vitest-environment node
import { expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock('@d2lang/d2', () => ({ D2: class { constructor() { throw new Error('Native app must not start the WASM worker'); } } }));
import { loadLayoutEngine } from '../src/layout-engine';
it('uses the bundled native engine for the desktop app', async () => {
  native.invoke.mockResolvedValue({diagram:{shapes:[{id:'n0',pos:{x:100,y:200}}],connections:[]}});
  const engine = await loadLayoutEngine();
  const nodes = [{id:'a',x:100,y:200,width:210,height:118}];
  expect([...(await engine.layout(nodes,[],'fixed')).nodes.values()]).toEqual(nodes);
  expect(native.invoke).toHaveBeenCalledWith('compile_d2', {source: expect.stringContaining('left: 100; top: 200')});
  await engine.dispose();
});
