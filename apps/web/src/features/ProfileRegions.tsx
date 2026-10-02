// Which regions of a sketch an extrude or revolve uses, for sketches with text (M3 plan, T3.2d):
// every region, the text only (all the letters of every text in one click: emboss with Add,
// deboss with Remove), or everything but the text (a plate with letter-shaped holes, the
// counters of its letters kept, as a stencil). A profile stores entity ids (`profile.entities`);
// regen picks the regions bounded by them (regen's `selectRegions`). Sketches without text show
// nothing here: their profiles stay as they were (every region, or the entities they listed).

import type { SketchFeature } from '@manufakture/core';
import {
  entitiesFor,
  otherEntities,
  regionChoice,
  textEntities,
  type RegionChoice,
} from './regions';

export interface ProfileRegionsProps {
  sketch: SketchFeature | undefined;
  entities: readonly string[] | undefined;
  onChange: (entities: string[] | undefined) => void;
}

export function ProfileRegions({ sketch, entities, onChange }: ProfileRegionsProps) {
  const texts = textEntities(sketch);
  if (texts.length === 0) return null;
  const others = otherEntities(sketch);
  const choice = regionChoice(sketch, entities);
  const option = (value: RegionChoice, label: string, disabled = false) => (
    <label key={value} className="dialog-check">
      <input
        type="radio"
        name="regions"
        value={value}
        checked={choice === value}
        disabled={disabled}
        data-testid={`regions-${value}`}
        onChange={() => {
          if (value !== 'custom') onChange(entitiesFor(sketch, value));
        }}
      />{' '}
      {label}
    </label>
  );
  return (
    <fieldset className="dialog-field checks" data-testid="field-regions">
      <legend>Regions</legend>
      {option('all', 'Every region')}
      {texts.length > 0 &&
        option('text', texts.length === 1 ? 'The text only' : `The texts only (${texts.length})`)}
      {texts.length > 0 && others.length > 0 && option('others', 'Everything but the text')}
      {choice === 'custom' && option('custom', `As picked (${entities?.length ?? 0} entities)`)}
      {choice === 'text' && (
        <p className="field-note">
          Every letter of the text. With Add the text is embossed; with Remove it is debossed.
        </p>
      )}
    </fieldset>
  );
}
