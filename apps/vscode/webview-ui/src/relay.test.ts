import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_LOAD_TIMEOUT_MS, relayHandoff, watchFrameLoad } from "./relay";

type Listener = () => void;

function fakeFrame() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: "load" | "error", listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: "load" | "error", listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: "load" | "error") {
      for (const l of [...(listeners.get(type) ?? [])]) l();
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

describe("watchFrameLoad", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts frame-error once when the frame reports an error", () => {
    const frame = fakeFrame();
    const post = vi.fn();
    watchFrameLoad(frame, post);
    frame.emit("error");
    frame.emit("error");
    vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS * 2);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: "blockbase:frame-error" });
  });

  it("posts frame-error once when the frame has not loaded within the timeout", () => {
    const frame = fakeFrame();
    const post = vi.fn();
    watchFrameLoad(frame, post);
    vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS - 1);
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS * 2);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: "blockbase:frame-error" });
  });

  it("honours a custom timeout", () => {
    const frame = fakeFrame();
    const post = vi.fn();
    watchFrameLoad(frame, post, undefined, 50);
    vi.advanceTimersByTime(50);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("posts nothing when the frame loads first", () => {
    const frame = fakeFrame();
    const post = vi.fn();
    watchFrameLoad(frame, post);
    frame.emit("load");
    vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS * 2);
    frame.emit("error");
    expect(post).not.toHaveBeenCalled();
  });

  it("posts nothing after cleanup and removes its listeners", () => {
    const frame = fakeFrame();
    const post = vi.fn();
    const stop = watchFrameLoad(frame, post);
    stop();
    frame.emit("error");
    vi.advanceTimersByTime(FRAME_LOAD_TIMEOUT_MS * 2);
    expect(post).not.toHaveBeenCalled();
    expect(frame.count()).toBe(0);
  });
});

describe("relayHandoff", () => {
  const ORIGIN = "https://fwd.example.test";
  const frameWindow = { name: "frame" };
  const valid = { origin: ORIGIN, source: frameWindow, data: { type: "blockbase:copy-handoff", componentId: "cmp_local_glow-card" } };

  it("relays a new object holding only the type and the id", () => {
    const relayed = relayHandoff({ ...valid, data: { ...valid.data, extra: "x" } }, ORIGIN, frameWindow);
    expect(relayed).toEqual({ type: "blockbase:copy-handoff", componentId: "cmp_local_glow-card" });
    expect(relayed).not.toBe(valid.data);
  });

  it("drops a wrong origin, a wrong source and a wrong type", () => {
    expect(relayHandoff({ ...valid, origin: "https://evil.example.test" }, ORIGIN, frameWindow)).toBeUndefined();
    expect(relayHandoff({ ...valid, source: {} }, ORIGIN, frameWindow)).toBeUndefined();
    expect(relayHandoff({ ...valid, data: { type: "blockbase:copy", componentId: "x" } }, ORIGIN, frameWindow)).toBeUndefined();
    expect(relayHandoff({ ...valid, data: null }, ORIGIN, frameWindow)).toBeUndefined();
  });

  it("never relays service actions or frame errors from the frame", () => {
    expect(relayHandoff({ ...valid, data: { type: "blockbase.service", action: "install" } }, ORIGIN, frameWindow)).toBeUndefined();
    expect(relayHandoff({ ...valid, data: { type: "blockbase:frame-error" } }, ORIGIN, frameWindow)).toBeUndefined();
  });

  it("applies the id bounds and charset", () => {
    const withId = (componentId: unknown) => relayHandoff({ ...valid, data: { type: "blockbase:copy-handoff", componentId } }, ORIGIN, frameWindow);
    expect(withId("")).toBeUndefined();
    expect(withId("a".repeat(200))).toBeDefined();
    expect(withId("a".repeat(201))).toBeUndefined();
    expect(withId("a\n[x](command:foo)")).toBeUndefined();
    expect(withId(5)).toBeUndefined();
  });
});
