/**
 * Undo and redo for the physics text. Blockbench's own undo does not know the physics property, so the Physics tab keeps this small history of the text
 * itself. A run of edits with the same key close together in time (dragging one slider fires an edit per pixel) is one step. No Blockbench globals
 */
export class History {
    private undoStack: string[] = [];
    private redoStack: string[] = [];
    private lastKey = '';
    private lastTime = -Infinity;

    constructor(private readonly limit = 100, private readonly mergeMs = 700) {}

    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }

    /** Call with the text as it is <em>before</em> an edit is applied */
    record(before: string, key: string, now: number): void {
        const merges = key === this.lastKey && now - this.lastTime < this.mergeMs;

        this.lastTime = now;
        this.lastKey = key;

        if (merges) return;

        if (this.undoStack[this.undoStack.length - 1] === before) return;

        this.undoStack.push(before);
        this.redoStack = [];

        if (this.undoStack.length > this.limit) this.undoStack.shift();
    }

    /** The text to go back to, given the current text, or null when there is nothing to undo */
    undo(current: string): string | null {
        const previous = this.undoStack.pop();

        if (previous === undefined) return null;

        this.redoStack.push(current);
        this.lastKey = '';

        return previous;
    }

    redo(current: string): string | null {
        const next = this.redoStack.pop();

        if (next === undefined) return null;

        this.undoStack.push(current);
        this.lastKey = '';

        return next;
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.lastKey = '';
        this.lastTime = -Infinity;
    }
}
