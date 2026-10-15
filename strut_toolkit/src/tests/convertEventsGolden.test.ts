import * as fs from 'fs';
import * as path from 'path';
import { convertAnimationFile } from '../ts/convert/animationToRaw';
import { encodeAnimation } from '../ts/binary/animation';
import { bindingSetFor, CueMapping, markerEventMapper, parseKeyframeEvents } from '../ts/convert/eventMapping';

/**
 * The event golden files the Java test reads (`ConverterEventsGoldenTest`): `cues.animation.json` and the cue table `lucy.cues.json` converted to `cues.strutanim`
 * and `lucy.bindings.json`. Regenerate on purpose with `WRITE_GOLDEN=1 npx jest tests/convertEventsGolden`
 */
/** The decisions the mapped golden was made with; the Java test states the same expectations independently */
export const MAPPED_RULES: CueMapping = {
    thrust: { action: 'marker', authority: 'server' },
    stripmsg1: { action: 'sound', value: 'pleasurehorizons:lucy.giggle', authority: 'client' },
    bjimsg8: { action: 'custom', value: 'pleasurehorizons:fade 1.5', authority: 'both' },
    sexui: { action: 'leave-out' },
};

const DIR = path.resolve(__dirname, '../../../../src/test/resources/converter');

describe('converter event golden files', () => {
    it('cues.strutanim and lucy.bindings.json are what the converter writes', () => {
        const tokens: string[] = [];
        const source = JSON.parse(fs.readFileSync(path.join(DIR, 'cues.animation.json'), 'utf8'));
        const { animation } = convertAnimationFile(source, {
            file: 'cues.animation.json', mapEvent: markerEventMapper({ onToken: token => tokens.push(token) }),
        });
        const bytes = encodeAnimation(animation);
        const registry = parseKeyframeEvents(JSON.parse(fs.readFileSync(path.join(DIR, 'lucy.cues.json'), 'utf8')), 'lucy.cues.json');
        const bindings = JSON.stringify(bindingSetFor(registry, tokens), null, 2) + '\n';

        if (process.env.WRITE_GOLDEN) {
            fs.writeFileSync(path.join(DIR, 'cues.strutanim'), bytes);
            fs.writeFileSync(path.join(DIR, 'lucy.bindings.json'), bindings);
        }

        expect(Buffer.from(bytes).equals(fs.readFileSync(path.join(DIR, 'cues.strutanim')))).toBe(true);
        expect(bindings).toBe(fs.readFileSync(path.join(DIR, 'lucy.bindings.json'), 'utf8'));
    });
});

describe('converter mapped-cue golden file', () => {
    it('mapped.strutanim is what the converter writes when the person overrides cues', () => {
        const source = JSON.parse(fs.readFileSync(path.join(DIR, 'cues.animation.json'), 'utf8'));
        const { animation } = convertAnimationFile(source, {
            file: 'cues.animation.json',
            mapEvent: markerEventMapper({ rules: MAPPED_RULES }),
        });
        const bytes = encodeAnimation(animation);

        if (process.env.WRITE_GOLDEN)
            fs.writeFileSync(path.join(DIR, 'mapped.strutanim'), bytes);

        expect(Buffer.from(bytes).equals(fs.readFileSync(path.join(DIR, 'mapped.strutanim')))).toBe(true);
    });
});
