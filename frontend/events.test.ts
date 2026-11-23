import { expect, test } from "bun:test";
import {
  createEventHub,
  parseDiskEvent,
  type ChannelLike,
  type DiskEvent,
  type LockManagerLike,
  type SourceLike,
} from "./events.ts";

// --- Dobles del navegador: varias «ventanas» comparten candados y canal --------

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeLockBus {
  held = false;
  queue: Array<() => void> = [];
}

function fakeLocks(bus: FakeLockBus): LockManagerLike {
  const run = async (callback: (lock: unknown) => Promise<void> | void) => {
    bus.held = true;
    try {
      await callback({ name: "lock" });
    } finally {
      bus.held = false;
      bus.queue.shift()?.();
    }
  };

  return {
    request(_name: string, first: unknown, second?: unknown): Promise<unknown> {
      const ifAvailable = typeof first === "object";
      const callback = (ifAvailable ? second : first) as (lock: unknown) => Promise<void> | void;
      if (ifAvailable) {
        return bus.held ? Promise.resolve(callback(null)) : run(callback);
      }
      return new Promise((resolve) => {
        const start = () => void run(callback).then(resolve);
        if (bus.held) bus.queue.push(start);
        else start();
      });
    },
  } as LockManagerLike;
}

class FakeChannelBus {
  channels = new Set<FakeChannel>();
}

class FakeChannel implements ChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(private bus: FakeChannelBus) {
    bus.channels.add(this);
  }
  postMessage(message: unknown) {
    // Como BroadcastChannel: llega a las demás, no a quien lo envía, y es asíncrono.
    for (const other of this.bus.channels) {
      if (other !== this) queueMicrotask(() => other.onmessage?.({ data: message }));
    }
  }
  close() {
    this.bus.channels.delete(this);
  }
}

class FakeSource implements SourceLike {
  closed = false;
  private listeners: Record<string, Array<(event: { data?: string }) => void>> = {};
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: string) {
    for (const listener of this.listeners[type] ?? []) listener({ data });
  }
}

function setup() {
  const locks = new FakeLockBus();
  const channels = new FakeChannelBus();
  const sources: FakeSource[] = [];

  function openWindow(name: string) {
    const events: string[] = [];
    const resyncs: boolean[] = [];
    const hub = createEventHub({
      url: "/api/events",
      onEvent: (event) => events.push(`${event.type}:${event.path}`),
      onResync: (full) => resyncs.push(full),
      locks: fakeLocks(locks),
      createChannel: () => new FakeChannel(channels),
      createSource: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
    });
    return { name, hub, events, resyncs };
  }

  return { openWindow, sources, channels };
}

const message = (event: DiskEvent) => JSON.stringify(event);

// --- Pruebas ------------------------------------------------------------------

test("parseDiskEvent acepta solo eventos válidos", () => {
  expect(parseDiskEvent({ type: "change", path: "a.md" })).toEqual({ type: "change", path: "a.md" });
  expect(parseDiskEvent({ type: "delete", path: "a.md", extra: 1 })).toEqual({
    type: "delete",
    path: "a.md",
  });
  expect(parseDiskEvent({ type: "rename", path: "a.md" })).toBeNull();
  expect(parseDiskEvent({ type: "change", path: 1 })).toBeNull();
  expect(parseDiskEvent(null)).toBeNull();
  expect(parseDiskEvent("change")).toBeNull();
});

test("resync del servidor fuerza revisión completa y se reparte a las demás ventanas", async () => {
  const { openWindow, sources } = setup();
  const leader = openWindow("lidere");
  const other = openWindow("otra");
  await tick();

  sources[0]!.emit("open");
  expect(leader.resyncs).toEqual([false]);
  expect(other.resyncs).toEqual([]);

  sources[0]!.emit("resync", "{}");
  await tick();
  expect(leader.resyncs).toEqual([false, true]);
  expect(other.resyncs).toEqual([true]);
});

test("sin Web Locks ni BroadcastChannel abre su propio flujo, como antes", () => {
  const sources: FakeSource[] = [];
  const events: string[] = [];
  const resyncs: boolean[] = [];
  const hub = createEventHub({
    url: "/api/events",
    onEvent: (event) => events.push(event.path),
    onResync: (full) => resyncs.push(full),
    locks: null,
    createChannel: null,
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  });

  expect(hub.leader).toBe(true);
  expect(sources).toHaveLength(1);
  sources[0]!.emit("open");
  sources[0]!.emit("message", message({ type: "change", path: "a.md" }));
  expect(resyncs).toEqual([false]);
  expect(events).toEqual(["a.md"]);
});

test("con varias ventanas solo la primera abre el flujo y las demás reciben los eventos", async () => {
  const { openWindow, sources } = setup();
  const first = openWindow("1");
  const second = openWindow("2");
  const third = openWindow("3");
  await tick();

  expect(sources).toHaveLength(1);
  expect([first.hub.leader, second.hub.leader, third.hub.leader]).toEqual([true, false, false]);

  sources[0]!.emit("open");
  sources[0]!.emit("message", message({ type: "change", path: "nota.md" }));
  sources[0]!.emit("message", message({ type: "delete", path: "vieja.md" }));
  await tick();

  for (const window of [first, second, third]) {
    expect(window.events).toEqual(["change:nota.md", "delete:vieja.md"]);
  }
  // La primera conexión solo refresca el índice de la líder; las demás no revisan nada.
  expect(first.resyncs).toEqual([false]);
  expect(second.resyncs).toEqual([]);
});

test("al cerrarse la líder otra ventana hereda el flujo y todas revisan el estado", async () => {
  const { openWindow, sources } = setup();
  const first = openWindow("1");
  const second = openWindow("2");
  const third = openWindow("3");
  await tick();
  sources[0]!.emit("open");
  await tick();

  first.hub.close();
  await tick();

  expect(sources[0]!.closed).toBe(true);
  expect(sources).toHaveLength(2);
  expect([second.hub.leader, third.hub.leader]).toEqual([true, false]);

  // Al abrirse el flujo heredado se revisa todo: lo ocurrido entremedias se perdió.
  sources[1]!.emit("open");
  await tick();
  expect(second.resyncs).toEqual([true]);
  expect(third.resyncs).toEqual([true]);

  sources[1]!.emit("message", message({ type: "change", path: "x.md" }));
  await tick();
  expect(second.events).toEqual(["change:x.md"]);
  expect(third.events).toEqual(["change:x.md"]);
});

test("una reconexión del flujo pide revisar el estado completo a todas las ventanas", async () => {
  const { openWindow, sources } = setup();
  const first = openWindow("1");
  const second = openWindow("2");
  await tick();

  sources[0]!.emit("open"); // primera conexión
  sources[0]!.emit("open"); // reconexión automática del EventSource
  await tick();

  expect(first.resyncs).toEqual([false, true]);
  expect(second.resyncs).toEqual([true]);
});

test("ignora mensajes inválidos, del flujo y del canal", async () => {
  const { openWindow, sources, channels } = setup();
  const first = openWindow("1");
  const second = openWindow("2");
  await tick();

  sources[0]!.emit("message", "no es json");
  sources[0]!.emit("message", message({ type: "rename", path: "a.md" } as unknown as DiskEvent));
  sources[0]!.emit("message", "null");
  await tick();
  expect(first.events).toEqual([]);
  expect(second.events).toEqual([]);

  // Un mensaje ajeno por el canal tampoco llega a la aplicación.
  const intruder = new FakeChannel(channels);
  intruder.postMessage({ kind: "event", event: { type: "change" } });
  intruder.postMessage({ kind: "otra-cosa" });
  intruder.postMessage("texto");
  await tick();
  expect(second.events).toEqual([]);
  expect(second.resyncs).toEqual([]);

  // Un mensaje válido por el mismo canal sí llega: la prueba no es vacua.
  intruder.postMessage({ kind: "event", event: { type: "change", path: "ok.md" } });
  await tick();
  expect(second.events).toEqual(["change:ok.md"]);
});

test("si Web Locks falla, abre un flujo propio en lugar de quedarse sin avisos", async () => {
  const sources: FakeSource[] = [];
  const hub = createEventHub({
    url: "/api/events",
    onEvent: () => {},
    onResync: () => {},
    locks: {
      request() {
        return Promise.reject(new Error("SecurityError"));
      },
    } as unknown as LockManagerLike,
    createChannel: () => new FakeChannel(new FakeChannelBus()),
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  });
  await tick();

  expect(sources).toHaveLength(1);
  expect(hub.leader).toBe(true);
});

test("cerrar el hub cierra el flujo y no abre otro después", async () => {
  const { openWindow, sources } = setup();
  const only = openWindow("1");
  await tick();
  only.hub.close();
  await tick();

  expect(sources).toHaveLength(1);
  expect(sources[0]!.closed).toBe(true);
  expect(only.hub.leader).toBe(false);
});
