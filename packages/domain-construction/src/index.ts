// @manufakture/domain-construction: the construction domain (M6). Framing generators that turn
// walls (and, later, floors and roofs) into member data, the member data shape and its ids, and
// the "not an engineering tool" text. See README.md.

export const packageName = '@manufakture/domain-construction';

export { DISCLAIMER_SHORT } from './disclaimer';
export {
  add,
  cross,
  dot,
  placementMatrix,
  scale,
  sub,
  toLocal,
  toWorld,
  zAxis,
  type Placement,
  type Plane,
  type Vec2,
  type Vec3,
} from './geom';
export {
  countByRole,
  memberCorners,
  shapeKey,
  type Cut,
  type Member,
  type Role,
  type StockRef,
} from './members';
export {
  formatOpeningMemberId,
  formatWallMemberId,
  memberFullId,
  memberIds,
  parseOpeningMemberId,
  parseWallMemberId,
  splitMemberFullId,
  type CornerMemberName,
  type OpeningMemberId,
  type TeeMemberName,
  type WallMemberId,
} from './member-ids';
export {
  DEFAULT_WALL_SETTINGS,
  FramingInputError,
  frameWall,
  resolveWallSettings,
  type BlockingRows,
  type CornerStyle,
  type FrameWallInput,
  type FramingWarning,
  type HeaderRule,
  type HeaderSpec,
  type Justification,
  type MemberOverride,
  type OpeningReport,
  type OverrideReport,
  type WallFraming,
  type WallJoin,
  type WallOpening,
  type WallSegment,
  type WallSettings,
  type WallSettingsInput,
  type WallTee,
  type WallWarningCode,
} from './framing/wall';
