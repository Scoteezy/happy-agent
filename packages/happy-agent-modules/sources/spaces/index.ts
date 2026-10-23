export {
    SPACE_STANDALONE_OWNER,
    spaceBatchSchema,
    spaceIconSchema,
    spaceRecordSchema,
    spaceRefSchema,
    spaceSectionRecordSchema,
    SpaceConflictError,
    SpaceInputError,
    SpaceNotFoundError,
    SpaceStorageError,
    type SpaceBatch,
    type SpaceDescription,
    type SpaceIcon,
    type SpaceOwnerId,
    type SpaceRecord,
    type SpaceRef,
    type SpaceSectionRecord,
    type SpaceSnapshot,
    type SpaceTarget,
} from "./Space.js";
export { spaceEventSchema, type SpaceEvent, type SpaceEventListener } from "./SpaceEvent.js";
export { spaceMigrations, SPACES_TABLE, SPACE_SECTIONS_TABLE } from "./SpaceMigrations.js";
export { SPACE_IDLE_MS, SpacesModule } from "./SpacesModule.js";
export { SPACE_ICON_SLUGS } from "./impl/spaceIconSlugs.js";
export { SidebarConflictError } from "./impl/sidebarLayout.js";
