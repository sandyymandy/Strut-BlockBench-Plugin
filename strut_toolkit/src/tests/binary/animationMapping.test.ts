import {
    interpolationFromLive, interpolationToLive, loopModeFromLive, loopModeToLive,
    liveChannelName, dataPointFromValue, toVec3,
} from '../../ts/binary/animationMapping';
import { RawValue } from '../../ts/binary/animation';

/**
 * strutAnimationCodec.ts itself can't be imported directly in a jest test - like strutCodec.ts
 * (see cubeUv.test.ts's own doc comment), it eventually imports ./codec, which touches
 * Blockbench globals at module scope - so the live-name ↔ wire-name conventions behind fork
 * phase 6 stage 5 live in their own dependency-free module instead
 */
describe('interpolationFromLive/interpolationToLive', () => {
    it('round-trips every known interpolation name', () => {
        expect(interpolationFromLive('step')).toEqual('STEP');
        expect(interpolationFromLive('catmullrom')).toEqual('CATMULLROM');
        expect(interpolationFromLive('bezier')).toEqual('BEZIER');
        expect(interpolationFromLive('linear')).toEqual('LINEAR');

        expect(interpolationToLive('STEP')).toEqual('step');
        expect(interpolationToLive('CATMULLROM')).toEqual('catmullrom');
        expect(interpolationToLive('BEZIER')).toEqual('bezier');
        expect(interpolationToLive('LINEAR')).toEqual('linear');
    });

    it('treats an unrecognised live interpolation as linear rather than throwing', () => {
        expect(interpolationFromLive('smooth')).toEqual('LINEAR');
        expect(interpolationFromLive('')).toEqual('LINEAR');
    });
});

describe('loopModeFromLive/loopModeToLive', () => {
    it('round-trips every known loop mode', () => {
        expect(loopModeFromLive('loop')).toEqual('LOOP');
        expect(loopModeFromLive('hold')).toEqual('HOLD_ON_LAST_FRAME');
        expect(loopModeFromLive('once')).toEqual('PLAY_ONCE');

        expect(loopModeToLive('LOOP')).toEqual('loop');
        expect(loopModeToLive('HOLD_ON_LAST_FRAME')).toEqual('hold');
        expect(loopModeToLive('PLAY_ONCE')).toEqual('once');
    });

    it('treats an unrecognised live loop value as play-once rather than throwing', () => {
        expect(loopModeFromLive('')).toEqual('PLAY_ONCE');
    });
});

describe('liveChannelName', () => {
    it('maps every property to its live channel string', () => {
        expect(liveChannelName('ROTATION')).toEqual('rotation');
        expect(liveChannelName('POSITION')).toEqual('position');
        expect(liveChannelName('SCALE')).toEqual('scale');
    });
});

describe('dataPointFromValue', () => {
    it('stringifies a literal component - KeyframeDataPoint#x/y/z are string-typed live, and addKeyframe() does not coerce a raw number itself', () => {
        const value: RawValue = { literals: [1, 2, 3], expressions: [null, null, null] };

        expect(dataPointFromValue(value)).toEqual({ x: '1', y: '2', z: '3' });
    });

    it('prefers a component expression over its (meaningless) literal, passed through unstringified', () => {
        const value: RawValue = {
            literals: [0, 0, 0],
            expressions: ['q.anim_time * 2', null, 'q.life_time'],
        };

        expect(dataPointFromValue(value)).toEqual({ x: 'q.anim_time * 2', y: '0', z: 'q.life_time' });
    });
});

describe('toVec3', () => {
    it('passes an array through component-wise', () => {
        expect(toVec3([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('falls back to the origin for anything that is not an array', () => {
        expect(toVec3(undefined)).toEqual([0, 0, 0]);
        expect(toVec3(null)).toEqual([0, 0, 0]);
        expect(toVec3('nonsense')).toEqual([0, 0, 0]);
    });

    it('treats a missing component within an array as 0, not undefined/NaN', () => {
        expect(toVec3([5])).toEqual([5, 0, 0]);
    });
});
