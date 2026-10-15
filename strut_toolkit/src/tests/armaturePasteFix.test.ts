/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadArmaturePasteFix, unloadArmaturePasteFix } from '../ts/armaturePasteFix';

/**
 * The copy half of the armature paste fix, against stand-ins for Blockbench's classes: an armature inside a group is saved with its content, a bare
 * armature copy carries its content and not its bones a second time, and unloading puts Blockbench's own functions back
 */
class FakeNode {
  children: any[] = [];
  constructor(public uuid: string, public type: string) {}
  getSaveCopy(): any {
    return { uuid: this.uuid, type: this.type, children: this.children.map(c => c.uuid) };
  }
  getTypeBehavior(): any {
    return true;
  }
  forEachChild(callback: (child: any) => void): void {
    for (const child of this.children) {
      callback(child);
      child.forEachChild?.(callback);
    }
  }
}

class FakeArmature extends FakeNode {
  constructor(uuid: string) { super(uuid, 'armature'); }
  extend(object: any): any { return object; }
}

class FakeBone extends FakeNode {
  constructor(uuid: string) { super(uuid, 'armature_bone'); }
}

class FakeGroup extends FakeNode {
  constructor(uuid: string) { super(uuid, 'group'); }
  getChildlessCopy(): any { return { uuid: this.uuid, type: 'group', children: [] }; }
  override getSaveCopy(nested?: boolean): any {
    const base = this.getChildlessCopy();

    if (nested)
      for (const child of this.children)
        base.children.push(child.getSaveCopy(nested));

    return base;
  }
}

function install() {
  const g = globalThis as any;
  const ownSetElements = jest.fn();

  g.Group = FakeGroup;
  g.Armature = FakeArmature;
  g.ArmatureBone = FakeBone;
  g.Clipbench = { elements: [] as any[], setElements: ownSetElements, pasteOutliner: jest.fn() };

  return { g, ownSetElements, ownGroupCopy: FakeGroup.prototype.getSaveCopy, ownExtend: FakeArmature.prototype.extend };
}

afterEach(() => {
  unloadArmaturePasteFix();
});

describe('armature paste fix', () => {
  test('an armature inside a group is saved with its bones, and without a children list', () => {
    install();
    loadArmaturePasteFix();

    const group = new FakeGroup('g');
    const armature = new FakeArmature('a');
    const bone = new FakeBone('b');

    armature.children.push(bone);
    group.children.push(armature);

    const saved = group.getSaveCopy(true);
    const savedArmature = saved.children[0];

    expect(savedArmature.type).toBe('armature');
    expect(savedArmature.children).toBeUndefined();
    expect(savedArmature.paste_children).toEqual(['b']);
    expect(savedArmature.paste_content.map((c: any) => c.uuid)).toEqual(['b']);
  });

  test('an armature copied by itself carries its content, and its bones are not copied a second time', () => {
    const { g } = install();
    loadArmaturePasteFix();

    const armature = new FakeArmature('a');
    const bone = new FakeBone('b');

    armature.children.push(bone);
    g.Clipbench.setElements([armature, bone]);

    expect(g.Clipbench.elements).toHaveLength(1);
    expect(g.Clipbench.elements[0].type).toBe('armature');
    expect(g.Clipbench.elements[0].paste_content).toHaveLength(1);
  });

  test('a pasted armature remembers its content, and nothing else is touched', () => {
    install();
    loadArmaturePasteFix();

    const armature: any = new FakeArmature('a');
    const content = [{ uuid: 'b', type: 'armature_bone', children: [] }];

    armature.extend({ paste_content: content, paste_children: ['b'] });
    expect(armature.__paste_armature).toEqual({ content, children: ['b'] });

    const plain: any = new FakeArmature('p');

    plain.extend({});
    expect(plain.__paste_armature).toBeUndefined();
  });

  test('unloading puts Blockbench\'s own functions back, and loading twice patches once', () => {
    const { g, ownSetElements, ownGroupCopy, ownExtend } = install();

    loadArmaturePasteFix();
    loadArmaturePasteFix();
    expect(g.Group.prototype.getSaveCopy).not.toBe(ownGroupCopy);

    unloadArmaturePasteFix();

    expect(g.Group.prototype.getSaveCopy).toBe(ownGroupCopy);
    expect(g.Armature.prototype.extend).toBe(ownExtend);
    expect(g.Clipbench.setElements).toBe(ownSetElements);
  });

  test('a Blockbench without armatures is left alone', () => {
    const g = globalThis as any;

    install();
    delete g.Armature;
    loadArmaturePasteFix();

    expect(g.Group.prototype.getSaveCopy).toBe(FakeGroup.prototype.getSaveCopy);
  });
});
