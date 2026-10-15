import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { folderProblem, outputPathFor, resolveInput, runBatch } from '../ts/convert/batch';
import { decodeAnimation } from '../ts/binary/animation';
import { decodeModel } from '../ts/binary/model';

/**
 * The folder-level converter (what the command line and the GUI run): a small made-up project with a model, two animation files, a cue table, and a
 * dev folder that must be ignored
 */
function write(root: string, relative: string, content: unknown): void {
    const target = path.join(root, relative);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
}

function project(): { input: string; output: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strut-convert-'));
    const input = path.join(base, 'assets');

    write(input, 'geo/nude/lucy.geo.json', { 'minecraft:geometry': [{ description: { identifier: 'geometry.lucy', texture_width: 16, texture_height: 16 },
        bones: [{ name: 'body', cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] }] }, { name: 'head', parent: 'body' }] }] });
    write(input, 'animations/base.lucy.animation.json', { animations: { 'animation.lucy.idle': { loop: true, animation_length: 1,
        bones: { head: { rotation: { '0': [0, 0, 0], '1': [0, 45, 0] } } }, sound_effects: { '0.5': { effect: 'stripMSG1, thrust' } } } } });
    write(input, 'animations/scenes/anal.scene.json', { animations: { 'animation.anal.loop': { animation_length: 2, sound_effects: { '1': { effect: 'analintroMSG1' } } } } });
    write(input, 'keyframe_events/lucy.json', { girl_id: 'lucy', events: [{ key: 'stripMSG1', random_sounds: ['pleasurehorizons:lucy.giggle'], messages: ['Hihi~'] },
        { key: 'unusedKey', sounds: ['pleasurehorizons:lucy.x'] }] });
    write(input, 'keyframe_events/example.json', { girl_id: 'daisy', events: [{ key: 'angry', sounds: ['pleasurehorizons:x'] }] });
    write(input, 'python/animations/input/copy.animation.json', { animations: { 'animation.copy': { animation_length: 1 } } });

    return { input, output: path.join(base, 'converted') };
}

/** A custom girl's resource pack: pack.mcmeta, assets/<namespace>/ with her own geo, animations, cue table and a texture */
function pack(girl = 'zoe', cueGirl = girl): { root: string; namespace: string; output: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strut-pack-'));
    const root = path.join(base, 'ZoePack');
    const namespace = path.join(root, 'assets', 'pleasurehorizons');

    write(root, 'pack.mcmeta', { pack: { pack_format: 34, description: 'zoe' } });
    write(namespace, `geo/nude/${girl}.geo.json`, { 'minecraft:geometry': [{ description: { identifier: `geometry.${girl}`, texture_width: 16, texture_height: 16 },
        bones: [{ name: 'body', cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] }] }, { name: 'head', parent: 'body' }] }] });
    write(namespace, `animations/base.${girl}.animation.json`, { animations: { 'animation.base.idle': { loop: true, animation_length: 1,
        bones: { head: { rotation: { '0': [0, 0, 0], '1': [0, 45, 0] } } }, sound_effects: { '0.5': { effect: 'stripMSG1' } } } } });
    write(namespace, `keyframe_events/${girl}.json`, { girl_id: cueGirl, events: [{ key: 'stripMSG1', sounds: [`pleasurehorizons:${girl}.giggle`], messages: ['Hihi~'] }] });
    write(namespace, 'textures/entity/zoe.png.mcmeta', { animation: {} });

    return { root, namespace, output: path.join(base, 'converted') };
}

describe('a custom girl resource pack', () => {
    it('converts when the namespace folder is given, with a binding file for her own cue table and a skeleton stamp from her own geo', () => {
        const { namespace, output } = pack();
        const result = runBatch({ input: namespace, output });

        expect([...result.written].sort()).toEqual([
            path.join('strut', 'animations', 'base.zoe.strutanim'),
            path.join('strut', 'models', 'nude', 'zoe.strutmodel'),
            path.join('strut', 'event_bindings', 'girls', 'zoe.json'),
        ].sort());

        const animation = decodeAnimation(fs.readFileSync(path.join(output, 'strut', 'animations', 'base.zoe.strutanim')), 'a');
        const model = decodeModel(fs.readFileSync(path.join(output, 'strut', 'models', 'nude', 'zoe.strutmodel')), 'm');

        expect(model.groupBones.map(b => b.name)).toEqual(['body', 'head']);
        expect(animation.skeletonFingerprint).not.toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(output, 'strut', 'event_bindings', 'girls', 'zoe.json'), 'utf8')).bindings.stripmsg1.sounds).toEqual(['pleasurehorizons:zoe.giggle']);
    });

    it('finds the namespace from the pack folder, or from its assets folder, and lays the files out the same way', () => {
        const { root, namespace, output } = pack();

        for (const input of [root, path.join(root, 'assets')]) {
            expect(resolveInput(input).folder).toBe(namespace);
            expect(folderProblem(input, output)).toBeNull();
        }

        const result = runBatch({ input: root, output });

        expect(result.written).toContain(path.join('strut', 'event_bindings', 'girls', 'zoe.json'));
        expect(result.written).toContain(path.join('strut', 'models', 'nude', 'zoe.strutmodel'));
        expect(result.report).toContain('The old files are in');
    });

    it('does not guess between two namespaces with assets, and leaves a folder that has geo itself alone', () => {
        const { root, namespace } = pack();

        write(root, 'assets/other/geo/x.geo.json', {});

        expect(folderProblem(root, null)).toMatch(/More than one folder/);
        expect(resolveInput(namespace).note).toBeNull();
    });

    it('says when a copied cue table still names another girl, since the bindings go to the girl it names', () => {
        const { namespace, output } = pack('zoe', 'lucy');
        const result = runBatch({ input: namespace, output });

        expect(result.report).toContain('says girl_id "lucy"');
        expect(result.written).toContain(path.join('strut', 'event_bindings', 'girls', 'lucy.json'));
    });
});

describe('output layout', () => {
    it('models go under strut/models and animations under strut/animations', () => {
        expect(outputPathFor(path.join('geo', 'nude', 'lucy.strutmodel'), 'model')).toBe(path.join('strut', 'models', 'nude', 'lucy.strutmodel'));
        expect(outputPathFor(path.join('animations', 'scenes', 'a.strutanim'), 'animation')).toBe(path.join('strut', 'animations', 'scenes', 'a.strutanim'));
        // a flat input (no geo or animations folder) goes under the new folder as it is
        expect(outputPathFor('lucy.strutmodel', 'model')).toBe(path.join('strut', 'models', 'lucy.strutmodel'));
        // only the first folder is dropped: a nested geo folder is part of the path
        expect(outputPathFor(path.join('geo', 'geo', 'x.strutmodel'), 'model')).toBe(path.join('strut', 'models', 'geo', 'x.strutmodel'));
    });
});

describe('runBatch', () => {
    it('converts models and animations, keeps paths, writes markers and only the used registry bindings, and ignores dev folders', () => {
        const { input, output } = project();
        const result = runBatch({ input, output });

        expect([...result.written].sort()).toEqual([
            path.join('strut', 'animations', 'base.lucy.strutanim'),
            path.join('strut', 'animations', 'scenes', 'anal.strutanim'),
            path.join('strut', 'models', 'nude', 'lucy.strutmodel'),
            path.join('strut', 'event_bindings', 'girls', 'lucy.json'),
        ].sort());

        const model = decodeModel(fs.readFileSync(path.join(output, 'strut', 'models', 'nude', 'lucy.strutmodel')), 'm');
        const idle = decodeAnimation(fs.readFileSync(path.join(output, 'strut', 'animations', 'base.lucy.strutanim')), 'a').clips[0];
        const bindings = JSON.parse(fs.readFileSync(path.join(output, 'strut', 'event_bindings', 'girls', 'lucy.json'), 'utf8'));

        expect(model.groupBones.map(b => b.name)).toEqual(['body', 'head']);
        expect(idle.events.map(e => [e.kind, e.payload])).toEqual([['instruction', 'stripmsg1'], ['instruction', 'thrust']]);
        expect(bindings).toEqual({ bindings: { stripmsg1: { random_sounds: ['pleasurehorizons:lucy.giggle'], 'pleasurehorizons:messages': ['stripmsg1'] } } });
        expect(fs.existsSync(path.join(output, 'convert-report.txt'))).toBe(true);
        expect(result.report).toContain('Skipped registry files: example.json');
    });

    it('turns a physics sidecar next to a model into its physics section, and reports what the model does not have', () => {
        const { input, output } = project();

        write(input, 'geo/nude/lucy.physics.json', { bones: { head: { preset: 'jiggle-soft' }, tail: { preset: 'tail' } } });

        const result = runBatch({ input, output });
        const model = decodeModel(fs.readFileSync(path.join(output, 'strut', 'models', 'nude', 'lucy.strutmodel')), 'm');
        const section = JSON.parse(new TextDecoder().decode(model.extensions!.get('strut_physics:physics')!));
        const file = result.files.find(f => f.output.endsWith('lucy.strutmodel'))!;

        expect(Object.keys(section.bones)).toEqual(['head', 'tail']);
        expect(file.summary).toContain('physics (2 bones, 0 chains, 0 colliders)');
        expect(file.findings.some(f => f.message.includes('bone "tail", which the model does not have'))).toBe(true);
        expect(result.written).not.toContain(path.join('strut', 'models', 'nude', 'lucy.physics.json'));
    });

    it('stamps an animation file with the skeleton of the model it is named for, and 0 when there is none', () => {
        const { input, output } = project();

        runBatch({ input, output });

        const named = decodeAnimation(fs.readFileSync(path.join(output, 'strut', 'animations', 'base.lucy.strutanim')), 'a');
        const unnamed = decodeAnimation(fs.readFileSync(path.join(output, 'strut', 'animations', 'scenes', 'anal.strutanim')), 'a');

        expect(named.skeletonFingerprint).not.toBe(0);
        expect(unnamed.skeletonFingerprint).toBe(0);
    });

    it('a dry run writes nothing and still reports; the input is never changed; legacy events keep sound events and write no bindings', () => {
        const { input, output } = project();
        const before = fs.readFileSync(path.join(input, 'animations', 'base.lucy.animation.json'), 'utf8');
        const dry = runBatch({ input, output, dryRun: true });

        expect(fs.existsSync(output)).toBe(false);
        expect(dry.files.length).toBe(4);
        expect(dry.report).toContain('dry run');

        const legacy = runBatch({ input, output, events: 'legacy' });
        const idle = decodeAnimation(fs.readFileSync(path.join(output, 'strut', 'animations', 'base.lucy.strutanim')), 'a').clips[0];

        expect(idle.events.map(e => [e.kind, e.payload])).toEqual([['sound', 'stripMSG1, thrust']]);
        expect(legacy.written.some(f => f.includes('event_bindings'))).toBe(false);
        expect(fs.readFileSync(path.join(input, 'animations', 'base.lucy.animation.json'), 'utf8')).toBe(before);
    });
});
