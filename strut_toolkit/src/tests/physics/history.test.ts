import { History } from '../../ts/physics/history';

describe('the physics history', () => {
    test('undo and redo walk back and forth through the edits', () => {
        const h = new History();
        let text = 'a';

        const edit = (to: string, key: string, at: number): void => {
            h.record(text, key, at);
            text = to;
        };

        edit('b', 'k1', 0);
        edit('c', 'k2', 5000);
        edit('d', 'k3', 10000);

        text = h.undo(text)!;
        expect(text).toBe('c');
        text = h.undo(text)!;
        expect(text).toBe('b');
        text = h.redo(text)!;
        expect(text).toBe('c');
        text = h.redo(text)!;
        expect(text).toBe('d');
        expect(h.redo(text)).toBeNull();
        expect(h.canRedo).toBe(false);
    });

    test('a drag of one slider is one step, and a different control or a pause is another', () => {
        const h = new History();
        let text = '0';

        for (let i = 1; i <= 30; i++) {
            h.record(text, 'controls:armL', i * 10);
            text = String(i);
        }

        h.record(text, 'controls:armR', 400);
        text = 'other';
        h.record(text, 'controls:armR', 5000);
        text = 'later';

        expect(text = h.undo(text)!).toBe('other');
        expect(text = h.undo(text)!).toBe('30');
        expect(text = h.undo(text)!).toBe('0');
        expect(h.undo(text)).toBeNull();
    });

    test('a new edit after an undo drops what could have been redone, and nothing is recorded twice for the same text', () => {
        const h = new History();

        h.record('a', 'x', 0);
        h.record('a', 'y', 9000);
        expect(h.undo('b')).toBe('a');
        expect(h.undo('a')).toBeNull();
        expect(h.canRedo).toBe(true);

        h.record('a', 'z', 20000);
        expect(h.canRedo).toBe(false);
    });

    test('the history is limited and can be cleared', () => {
        const h = new History(3);

        for (let i = 0; i < 10; i++) h.record(String(i), `k${i}`, i * 5000);

        const seen: string[] = [];
        let text = 'end';

        for (let n = h.undo(text); n !== null; n = h.undo(text)) {
            seen.push(n);
            text = n;
        }

        expect(seen).toEqual(['9', '8', '7']);
        h.record('q', 'q', 0);
        h.clear();
        expect(h.canUndo).toBe(false);
    });
});
