import { migrateLegacyProjectFields } from '../ts/legacyMigration';

describe('migrateLegacyProjectFields', () => {
  it('backfills the new keys from the legacy ones when the new keys are absent', () => {
    const model: any = {
      geckolib_modid: 'my_mod',
      geckolib_model_type: 'Entity',
      geckolib_filepath_cache: { model: 'a.geo' },
    };

    migrateLegacyProjectFields(model);

    expect(model.strut_modid).toEqual('my_mod');
    expect(model.strut_model_type).toEqual('Entity');
    expect(model.strut_filepath_cache).toEqual({ model: 'a.geo' });
  });

  it('leaves a project already on the new keys untouched', () => {
    const model: any = {
      strut_modid: 'already_strut',
      geckolib_modid: 'stale_value',
    };

    migrateLegacyProjectFields(model);

    expect(model.strut_modid).toEqual('already_strut');
  });

  it('is a no-op for a project with neither key', () => {
    const model: any = {};

    migrateLegacyProjectFields(model);

    expect(model.strut_modid).toBeUndefined();
    expect(model.strut_model_type).toBeUndefined();
    expect(model.strut_filepath_cache).toBeUndefined();
  });
});
