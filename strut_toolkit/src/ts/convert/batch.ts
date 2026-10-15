import * as fs from 'fs';
import * as path from 'path';
import { encodeAnimation, RawBinaryAnimation } from '../binary/animation';
import { encodeModel, RawBinaryModel } from '../binary/model';
import { convertAnimationFile, EventMapper } from './animationToRaw';
import {
    bindingSetFor, classifyToken, CueMapping, CueRule, GirlRegistry, markerEventMapper, MESSAGES_ACTION, parseKeyframeEvents, ruleProblem, Tag,
} from './eventMapping';
import { convertGeoFile, skeletonFingerprintOf } from './geoToRaw';
import { describeFinding, Finding } from './report';
import { checkPhysics, encodePhysicsSection, PHYSICS_SECTION } from '../physics/config';

/**
 * Converts a folder of legacy files: every {@code .geo.json} to a {@code .strutmodel}, every {@code .animation.json} and {@code .scene.json} to a
 * {@code .strutanim}, keeping relative paths, plus the binding files built from PH's {@code keyframe_events}. Never touches the input; nothing is written
 * in a dry run. Used by the command line and the GUI (AI Info/CONVERTER_PLAN.md)
 */
export interface BatchOptions {
    readonly input: string;
    readonly output: string;
    /** {@code markers}: each cue token becomes a marker (the default). {@code legacy}: cues are written as they were, as sound events */
    readonly events?: 'markers' | 'legacy';
    /** A folder of {@code <girl>.json} registry files; default {@code <input>/keyframe_events} when it exists */
    readonly keyframeEvents?: string;
    /** What to do with individual cues instead of the automatic marker; see {@link CueRule}. Only used with {@code events: 'markers'} */
    readonly mapping?: CueMapping;
    readonly dryRun?: boolean;
}

/**
 * The output path of a converted file, relative to the output folder: models under {@code strut/models/} and animations under {@code strut/animations/}, the old
 * {@code geo/} and {@code animations/} folder replaced by them (so {@code geo/nude/lucy.geo.json} becomes {@code strut/models/nude/lucy.strutmodel}), the only
 * folders the game reads
 */
export function outputPathFor(relative: string, kind: 'model' | 'animation'): string {
    const parts = relative.split(/[\\/]/);
    const folder = kind === 'model' ? 'geo' : 'animations';
    const rest = parts[0] === folder ? parts.slice(1) : parts;

    return path.join('strut', kind === 'model' ? 'models' : 'animations', ...rest);
}

export interface FileResult {
    readonly source: string;
    readonly output: string;
    readonly kind: 'model' | 'animation' | 'bindings';
    readonly summary: string;
    readonly findings: readonly Finding[];
}

export interface CueSummary {
    readonly token: string;
    /** How many times the cue occurs across every animation file */
    readonly count: number;
    readonly tag: Tag;
    /** Up to three places it occurs */
    readonly examples: readonly { readonly file: string; readonly clip: string; readonly time: number }[];
    /** What the registry attaches to it, in words ("random sounds", "a chat message"); empty when nothing */
    readonly does: readonly string[];
    /** The person's override, if any */
    readonly rule: CueRule | null;
}

export interface BatchResult {
    readonly files: readonly FileResult[];
    /** Every distinct cue token written as a marker, with what it is; empty with {@code events: 'legacy'} */
    readonly cues: readonly CueSummary[];
    readonly written: readonly string[];
    /** Rules that cannot be applied, in plain words */
    readonly mappingProblems: readonly string[];
    readonly lossy: number;
    readonly report: string;
}

const ASSET_FOLDERS = ['geo', 'animations', 'keyframe_events'];

const hasAssets = (dir: string): boolean => ASSET_FOLDERS.some(name => fs.existsSync(path.join(dir, name)) && fs.statSync(path.join(dir, name)).isDirectory());

const subfolders = (dir: string): string[] => (fs.existsSync(dir) && fs.statSync(dir).isDirectory()
    ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)).sort()
    : []);

/**
 * Where the old files really are. A folder with {@code geo/}, {@code animations/} or {@code keyframe_events/} in it is used as it is. A resource pack folder
 * ({@code <pack>/assets/<namespace>/geo/...}), an {@code assets} folder, or a folder of namespaces is searched for the one namespace folder that has them,
 * so a pack author can point at the pack. More than one namespace with assets cannot be guessed: that is a problem the person must settle
 */
export function resolveInput(input: string): { folder: string; note: string | null; problem: string | null } {
    const resolved = path.resolve(input);

    if (!fs.existsSync(resolved) || hasAssets(resolved))
        return { folder: resolved, note: null, problem: null };

    const found = [...subfolders(path.join(resolved, 'assets')), ...subfolders(resolved)].filter(hasAssets);
    const unique = [...new Set(found)];

    if (unique.length === 1)
        return { folder: unique[0], note: `The old files are in ${unique[0]} (found inside ${resolved}); the new files are laid out relative to it, so copy them into that namespace's folder in your pack.`, problem: null };

    if (unique.length > 1)
        return { folder: resolved, note: null, problem: `More than one folder in ${resolved} has geo, animations or keyframe_events (${unique.map(f => path.basename(f)).join(', ')}). Choose one of them as the old files folder.` };

    return { folder: resolved, note: null, problem: null };
}

/**
 * Why a pair of folders cannot be used, in plain words, or null. The output must be outside the input so the old files can never be overwritten
 */
export function folderProblem(input: string, output: string | null): string | null {
    const resolvedInput = path.resolve(input);

    if (!fs.existsSync(resolvedInput) || !fs.statSync(resolvedInput).isDirectory())
        return `The folder with the old files does not exist: ${resolvedInput}`;

    const ambiguous = resolveInput(resolvedInput).problem;

    if (ambiguous !== null)
        return ambiguous;

    if (output === null)
        return null;

    const resolvedOutput = path.resolve(output);

    if (resolvedInput === resolvedOutput || resolvedOutput.startsWith(resolvedInput + path.sep))
        return 'The new files must go in a folder outside the old files folder, so the old files can never be overwritten.';

    if (resolvedInput.startsWith(resolvedOutput + path.sep))
        return 'The new files folder must not contain the old files folder.';

    return null;
}

const BINDINGS_DIR = path.join('strut', 'event_bindings', 'girls');

function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);

        return entry.isDirectory() ? walk(full) : [full];
    }).sort();
}

/** The id a shared animation file is named for: {@code base.lucy.animation.json} and {@code doggy-momo.scene.json} are for {@code lucy} and {@code momo} */
function modelIdOf(fileName: string): string | null {
    const animation = /\.([A-Za-z0-9_]+)\.animation\.json$/.exec(fileName);
    const scene = /-([A-Za-z0-9_]+)\.scene\.json$/.exec(fileName);

    return animation?.[1] ?? scene?.[1] ?? null;
}

export function runBatch(given: BatchOptions): BatchResult {
    const where = resolveInput(given.input);
    const options: BatchOptions = { ...given, input: where.folder };
    const notes: string[] = where.note === null ? [] : [where.note];
    const files: FileResult[] = [];
    const written: string[] = [];
    const mappingProblems: string[] = [];
    const write = (relative: string, bytes: Uint8Array | string): void => {
        if (options.dryRun)
            return;

        const target = path.join(options.output, relative);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        written.push(relative);
    };
    // Only the asset folders: a dev folder such as python/ inside an assets folder holds copies that must not be converted a second time
    const roots = ['geo', 'animations'].map(name => path.join(options.input, name)).filter(dir => fs.existsSync(dir));
    const all = (roots.length > 0 ? roots : [options.input]).flatMap(walk);
    const models = new Map<string, RawBinaryModel>();
    const modelFingerprints = new Map<string, number>();

    // Models first: an animation file is stamped with the skeleton of the model it is named for
    for (const file of all.filter(f => f.endsWith('.geo.json'))) {
        const relative = path.relative(options.input, file);
        const converted = convertGeoFile(JSON.parse(fs.readFileSync(file, 'utf8')), { file: relative });
        const { findings } = converted;
        let model = converted.model;
        let physicsNote = '';

        // Physics for a model: a sidecar next to it, lucy.geo.json with lucy.physics.json, becomes the model's strut_physics:physics section
        const physicsFile = file.replace(/\.geo\.json$/, '.physics.json');

        if (fs.existsSync(physicsFile)) {
            const text = fs.readFileSync(physicsFile, 'utf8');
            const check = checkPhysics(text, model.groupBones.map(b => b.name));
            const section = encodePhysicsSection(text);

            for (const warning of check.warnings)
                findings.add('lossy', `physics: ${warning}`, { file: path.relative(options.input, physicsFile) });

            if (section !== null) {
                model = { ...model, extensions: new Map([[PHYSICS_SECTION, section]]) };
                physicsNote = `, physics (${check.bones} bones, ${check.chains} chains, ${check.colliders} colliders)`;
            }
        }
        const outputPath = outputPathFor(relative.replace(/\.geo\.json$/, '.strutmodel'), 'model');
        const id = path.basename(file).replace(/\.geo\.json$/, '');

        models.set(relative, model);

        // Both a nude and a dressed model share an id; the nude one names the skeleton, as PH's animations are authored against it
        if (!modelFingerprints.has(id) || relative.includes(`${path.sep}nude${path.sep}`))
            modelFingerprints.set(id, skeletonFingerprintOf(model));

        write(outputPath, encodeModel(model));
        files.push({
            source: relative, output: outputPath, kind: 'model', findings: findings.items,
            summary: `${model.groupBones.length} bones, ${model.cubes.length} cubes${physicsNote}`,
        });
    }

    const registries: GirlRegistry[] = [];
    const eventsDir = options.keyframeEvents ?? (fs.existsSync(path.join(options.input, 'keyframe_events')) ? path.join(options.input, 'keyframe_events') : null);
    const skippedRegistries: string[] = [];

    if (eventsDir !== null && fs.existsSync(eventsDir)) {
        for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.json')).sort()) {
            if (file === 'example.json') {
                skippedRegistries.push(file);

                continue;
            }

            const registry = parseKeyframeEvents(JSON.parse(fs.readFileSync(path.join(eventsDir, file), 'utf8')), file);

            // the bindings are written for the girl the table names, which is what the game looks them up by: a copied table with the old name inside is a trap
            if (registry.girlId !== file.replace(/\.json$/, ''))
                notes.push(`keyframe_events/${file} says girl_id "${registry.girlId}", so its bindings are written to strut/event_bindings/girls/${registry.girlId}.json. If this table is for "${file.replace(/\.json$/, '')}", change girl_id in it.`);

            registries.push(registry);
        }
    }

    const useMarkers = (options.events ?? 'markers') === 'markers';
    const tokenCounts = new Map<string, number>();
    const cueCounts = new Map<string, number>();
    const cueExamples = new Map<string, { file: string; clip: string; time: number }[]>();
    let currentFile = '';
    const mapper: EventMapper | undefined = useMarkers
        ? markerEventMapper({
            rules: options.mapping,
            onCue: (token, event) => {
                const examples = cueExamples.get(token) ?? [];

                cueCounts.set(token, (cueCounts.get(token) ?? 0) + 1);

                if (examples.length < 3)
                    examples.push({ file: currentFile, clip: event.clip, time: event.time });

                cueExamples.set(token, examples);
            },
            onToken: token => tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1),
        })
        : undefined;

    for (const [token, rule] of Object.entries(options.mapping ?? {})) {
        const problem = ruleProblem(token, rule);

        if (problem !== null)
            mappingProblems.push(problem);
    }

    for (const file of all.filter(f => /\.(animation|scene)\.json$/.test(f))) {
        const relative = path.relative(options.input, file);
        const id = modelIdOf(path.basename(file));

        currentFile = relative;
        const fingerprint = id !== null ? modelFingerprints.get(id) : undefined;
        const { animation, findings } = convertAnimationFile(JSON.parse(fs.readFileSync(file, 'utf8')), {
            file: relative, skeletonFingerprint: fingerprint ?? 0, mapEvent: mapper,
        });
        const outputPath = outputPathFor(relative.replace(/\.(animation|scene)\.json$/, '.strutanim'), 'animation');

        if (fingerprint === undefined)
            findings.add('info', 'no model of the same name, so its skeleton is not checked in game (fingerprint 0)', { file: relative });

        write(outputPath, encodeAnimation(animation));
        files.push({ source: relative, output: outputPath, kind: 'animation', findings: findings.items, summary: describeAnimation(animation) });
    }

    const bindingFiles: FileResult[] = [];

    if (useMarkers) {
        for (const girl of registries) {
            const set = bindingSetFor(girl, tokenCounts.keys());
            const relative = path.join(BINDINGS_DIR, `${girl.girlId}.json`);

            write(relative, JSON.stringify(set, null, 2) + '\n');
            bindingFiles.push({
                source: path.join('keyframe_events', girl.file), output: relative, kind: 'bindings', findings: [],
                summary: `${Object.keys(set.bindings).length} bindings`,
            });
        }
    }

    files.push(...bindingFiles);

    const report = (notes.length > 0 ? `${notes.join('\n')}\n\n` : '') + writeReport(files, tokenCounts, registries, skippedRegistries, options);

    if (!options.dryRun)
        fs.writeFileSync(path.join(options.output, 'convert-report.txt'), report);

    const bound = new Map<string, Set<string>>();

    for (const girl of registries) {
        for (const [token, binding] of Object.entries(bindingSetFor(girl, cueCounts.keys()).bindings)) {
            const set = bound.get(token) ?? new Set<string>();

            for (const key of Object.keys(binding))
                set.add(key === 'sounds' ? 'a sound' : key === 'random_sounds' ? 'a random sound' : key === MESSAGES_ACTION ? 'a chat message from the girl' : 'a chat message from the player');

            bound.set(token, set);
        }
    }

    const cues: CueSummary[] = [...cueCounts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([token, count]) => ({
        token, count, tag: classifyToken(token, registries), examples: cueExamples.get(token) ?? [], does: [...(bound.get(token) ?? [])],
        rule: options.mapping?.[token] ?? null,
    }));

    if (!options.dryRun && useMarkers && options.mapping !== undefined && Object.keys(options.mapping).length > 0) {
        fs.writeFileSync(path.join(options.output, 'converter-mapping.json'), JSON.stringify({ cues: options.mapping }, null, 2) + '\n');
        written.push('converter-mapping.json');
    }

    return { files, cues, written, mappingProblems, lossy: files.reduce((n, f) => n + f.findings.filter(x => x.severity === 'lossy').length, 0), report };
}

function describeAnimation(animation: RawBinaryAnimation): string {
    let keys = 0;
    let events = 0;

    for (const clip of animation.clips) {
        events += clip.events.length;

        for (const channel of clip.channels)
            keys += channel.keys.length;
    }

    return `${animation.clips.length} clips, ${keys} keys, ${events} events`;
}

function writeReport(files: readonly FileResult[], tokens: ReadonlyMap<string, number>, registries: readonly GirlRegistry[],
                     skipped: readonly string[], options: BatchOptions): string {
    const lines: string[] = [];
    const count = (severity: string): number => files.reduce((n, f) => n + f.findings.filter(x => x.severity === severity).length, 0);

    lines.push(`Strut asset conversion${options.dryRun ? ' (dry run: nothing was written)' : ''}`);
    lines.push(`from ${options.input}`);
    lines.push(`to   ${options.output}`);
    lines.push('');

    for (const kind of ['model', 'animation', 'bindings'] as const) {
        const group = files.filter(f => f.kind === kind);

        if (group.length === 0)
            continue;

        lines.push(`${kind === 'model' ? 'Models' : kind === 'animation' ? 'Animations' : 'Binding files'} (${group.length})`);

        for (const file of group)
            lines.push(`  ${file.output}  ${file.summary}${file.findings.length > 0 ? `  [${file.findings.length} notes]` : ''}`);

        lines.push('');
    }

    lines.push(`Findings: ${count('lossy')} need a look, ${count('changed')} changed on purpose, ${count('info')} for information`);

    for (const severity of ['lossy', 'changed', 'info'] as const) {
        const items = files.flatMap(f => f.findings).filter(x => x.severity === severity);

        if (items.length === 0)
            continue;

        lines.push('');
        lines.push(`${severity === 'lossy' ? 'Needs a look' : severity === 'changed' ? 'Changed on purpose' : 'For information'} (${items.length})`);

        const grouped = new Map<string, number>();

        for (const item of items) {
            const key = describeFinding(item);

            grouped.set(key, (grouped.get(key) ?? 0) + 1);
        }

        for (const [text, n] of [...grouped].slice(0, 200))
            lines.push(`  ${n > 1 ? `${n}x ` : ''}${text}`);

        if (grouped.size > 200)
            lines.push(`  ... and ${grouped.size - 200} more`);
    }

    if (tokens.size > 0) {
        const byTag = new Map<Tag, string[]>();

        for (const token of [...tokens.keys()].sort()) {
            const tag = classifyToken(token, registries);

            byTag.set(tag, [...(byTag.get(tag) ?? []), token]);
        }

        lines.push('');
        lines.push(`Event cues: ${tokens.size} distinct markers written, from ${[...tokens.values()].reduce((a, b) => a + b, 0)} uses`);

        for (const tag of ['gameplay', 'ui', 'message/sound', 'no consumer', 'inert'] as Tag[]) {
            const list = byTag.get(tag) ?? [];

            if (list.length > 0)
                lines.push(`  ${tag} (${list.length}): ${list.slice(0, 40).join(', ')}${list.length > 40 ? ', ...' : ''}`);
        }

        lines.push('  A comma list used to fire no chat message; one marker per token now does, so some messages will appear that did not before.');
    }

    if (skipped.length > 0)
        lines.push('', `Skipped registry files: ${skipped.join(', ')} (example data)`);

    return lines.join('\n') + '\n';
}
