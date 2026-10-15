/**
 * The Blockbench side of Strut Physics: one dialog, "Strut Physics...", to edit the model's physics text (kept in the project and written into the
 * {@code .strutmodel} as its {@code strut_physics:physics} section), check it the way the game does, and preview how each configured bone and chain answers
 * a scripted walk with the same solvers the game runs. This file is the only physics code that touches Blockbench globals; the logic is in {@code physics/}
 * and is tested without Blockbench. The dialog itself has not been opened in Blockbench by the author of this change
 */
import { PROPERTY_PHYSICS } from './constants';
import { checkPhysics, SPRING_PRESETS, starterPhysics } from './physics/config';
import { NamedTrace, respond } from './physics/preview';

const COLOURS = ['#e6552b', '#3ba0e8', '#4cc36b', '#d9a621', '#a16be0', '#e05a9a', '#2bc0c0', '#8a8a8a'];

/** The names of every bone (outliner group) in the open project */
export function groupNames(): string[] {
    const names: string[] = [];
    const visit = (nodes: any[]): void => {
        for (const node of nodes) {
            if (typeof Group !== 'undefined' && node instanceof Group) names.push(node.name);

            if (Array.isArray(node.children)) visit(node.children);
        }
    };

    visit((Outliner as any).root ?? []);

    return names;
}

export function getPhysicsText(): string {
    return String((Project as any)?.[PROPERTY_PHYSICS] ?? '');
}

function setPhysicsText(text: string): void {
    (Project as any)[PROPERTY_PHYSICS] = text;
    (Project as any).saved = false;
}

/** Draws the response curves on a canvas: offset against time, one line per bone or chain, with the peak and the time to settle under the plot */
export function drawTraces(canvas: HTMLCanvasElement, traces: readonly NamedTrace[]): string[] {
    const context = canvas.getContext('2d');
    const notes: string[] = [];

    if (!context) return notes;

    const w = canvas.width;
    const h = canvas.height;

    context.clearRect(0, 0, w, h);
    context.strokeStyle = '#888';
    context.strokeRect(0.5, 0.5, w - 1, h - 1);

    // the scripted walk: speeding up for a second, then a hard stop at 2 s
    context.fillStyle = 'rgba(128,128,128,0.15)';
    context.fillRect(0, 0, w * 1 / 5, h);
    context.fillRect(w * 2 / 5, 0, w * 0.25 / 5, h);

    traces.forEach((named, index) => {
        const { seconds, offset, peak, settle } = named.trace;

        // each on its own vertical scale: bones are in radians and chains in blocks, and only the shape and the settle time compare
        context.strokeStyle = COLOURS[index % COLOURS.length];
        context.beginPath();

        for (let i = 0; i < seconds.length; i += 2) {
            const x = seconds[i] / 5 * w;
            const y = h - 6 - (offset[i] / peak) * (h - 12);

            if (i === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
        }

        context.stroke();
        notes.push(`${named.kind} ${named.name}: peak ${named.kind === 'bone' ? `${(peak * 180 / Math.PI).toFixed(1)} deg` : `${(peak * 16).toFixed(1)} units`}, settles ${settle.toFixed(2)} s after the stop`);
    });

    return notes;
}

/** Opens the physics dialog */
export function openPhysicsDialog(): void {
    const bones = groupNames();
    const initial = getPhysicsText() || '{\n  "bones": {\n  }\n}';
    const status = (text: string): void => {
        const element = document.getElementById('strut-physics-status');

        if (element) element.textContent = text;
    };
    const currentText = (): string => String((dialog as any).getFormResult().physics ?? '');
    const report = (text: string): boolean => {
        const check = checkPhysics(text, bones);

        status(check.warnings.length === 0
            ? `OK: ${check.bones} bones, ${check.chains} chains, ${check.colliders} colliders`
            : `${check.warnings.length} problem(s):\n- ${check.warnings.join('\n- ')}`);

        return check.document !== null;
    };

    const dialog: any = new (Dialog as any)({
        id: 'strut_physics_dialog',
        title: 'Strut Physics',
        width: 640,
        form: {
            physics: { label: 'Physics (JSON)', type: 'textarea', value: initial, height: 260 },
        },
        lines: [
            `<p style="opacity:.75">Springs for jiggle, chains for hair and tails, colliders on bones, per bone in the JSON below. Presets: ${SPRING_PRESETS.join(', ')}. `
            + 'It is saved with the project and written into the exported .strutmodel. The same text works as a sidecar in a resource pack.</p>',
            '<canvas id="strut-physics-plot" width="600" height="120" style="width:100%"></canvas>',
            '<pre id="strut-physics-status" style="white-space:pre-wrap;max-height:120px;overflow:auto"></pre>',
        ],
        buttons: ['Save', 'Check', 'Preview', 'Fill from bones', 'Cancel'],
        confirm_index: 0,
        cancel_index: 4,
        onConfirm() {
            setPhysicsText(currentText());
        },
        onButton(index: number) {
            if (index === 1) {
                report(currentText());

                return false;
            }

            if (index === 2) {
                const check = checkPhysics(currentText(), bones);
                const canvas = document.getElementById('strut-physics-plot') as HTMLCanvasElement | null;

                if (check.document === null || !canvas) {
                    report(currentText());

                    return false;
                }

                status(drawTraces(canvas, respond(check.document)).join('\n') || 'Nothing to preview: add a bone or a chain');

                return false;
            }

            if (index === 3) {
                (dialog as any).setFormValues({ physics: starterPhysics(bones) });
                report(starterPhysics(bones));

                return false;
            }

            return undefined;
        },
    });

    dialog.show();
    report(initial);
}
