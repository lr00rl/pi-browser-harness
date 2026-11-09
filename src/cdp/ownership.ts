export type OwnershipRegistry = {
  add(targetId: string): void;
  remove(targetId: string): void;
  has(targetId: string): boolean;
  list(): ReadonlyArray<string>;
  replaceAll(ids: ReadonlyArray<string>): void;
  // Borrowed targets are protected from window adoption and cleanup, but are not persisted as owned.
  borrow(targetId: string): void;
  unborrow(targetId: string): void;
  isBorrowed(targetId: string): boolean;
  borrowedList(): ReadonlyArray<string>;
  setHarnessWindow(targetId: string | undefined): void;
  harnessWindow(): string | undefined;
  setHarnessWindowId(windowId: number | undefined): void;
  harnessWindowId(): number | undefined;
  // Subscribe; the returned function unsubscribes. Several subscribers may be registered at once.
  onChange(cb: () => void): () => void;
};

export const createOwnershipRegistry = (
  initial?: {
    readonly ownedTargetIds?: ReadonlyArray<string>;
    readonly harnessWindowTargetId?: string;
    readonly harnessWindowId?: number;
  },
): OwnershipRegistry => {
  const owned = new Set<string>(initial?.ownedTargetIds ?? []);
  const borrowed = new Set<string>();
  let harnessWindow: string | undefined = initial?.harnessWindowTargetId;
  let harnessWindowId: number | undefined = initial?.harnessWindowId;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    // Snapshot so a listener that unsubscribes (or subscribes) mid-notify does not disturb the iteration.
    for (const cb of [...listeners]) cb();
  };

  return {
    add(targetId) {
      if (borrowed.has(targetId) || owned.has(targetId)) return;
      owned.add(targetId);
      notify();
    },
    remove(targetId) {
      if (!owned.has(targetId) && !borrowed.has(targetId) && harnessWindow !== targetId) return;
      owned.delete(targetId);
      borrowed.delete(targetId);
      if (harnessWindow === targetId) harnessWindow = undefined;
      notify();
    },
    has(targetId) {
      return owned.has(targetId);
    },
    list() {
      return [...owned];
    },
    replaceAll(ids) {
      owned.clear();
      for (const id of ids) {
        if (!borrowed.has(id)) owned.add(id);
      }
      notify();
    },
    borrow(targetId) {
      if (borrowed.has(targetId)) return;
      owned.delete(targetId);
      borrowed.add(targetId);
    },
    unborrow(targetId) {
      borrowed.delete(targetId);
    },
    isBorrowed(targetId) {
      return borrowed.has(targetId);
    },
    borrowedList() {
      return [...borrowed];
    },
    setHarnessWindow(targetId) {
      if (harnessWindow === targetId) return;
      harnessWindow = targetId;
      notify();
    },
    harnessWindow() {
      return harnessWindow;
    },
    setHarnessWindowId(windowId) {
      if (harnessWindowId === windowId) return;
      harnessWindowId = windowId;
      notify();
    },
    harnessWindowId() {
      return harnessWindowId;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
};

// Drops owned targets (and the harness window) that no longer exist in the browser. Returns the owned ids that survived.
export const reconcileOwnership = (
  ownership: OwnershipRegistry,
  liveTargetIds: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const owned = ownership.list();
  const survivors = owned.filter((id) => liveTargetIds.has(id));
  if (survivors.length !== owned.length) ownership.replaceAll(survivors);
  const hw = ownership.harnessWindow();
  if (hw !== undefined && !liveTargetIds.has(hw)) ownership.setHarnessWindow(undefined);
  return survivors;
};
