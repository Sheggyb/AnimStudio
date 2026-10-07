// Undo/redo over immutable snapshots. A snapshot is whatever the app hands us (cheap: clips are
// copy-on-write, so a snapshot is mostly array references).
export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  push(label, snapshot) {
    this.undoStack.push({ label, snapshot });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  /** Returns the snapshot to restore, after storing `current` on the opposite stack. */
  undo(current) {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, snapshot: current });
    return e;
  }
  redo(current) {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, snapshot: current });
    return e;
  }
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get nextUndo() {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }
  get nextRedo() {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }
}
