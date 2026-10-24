import {
    parseSpaceSidebar,
    SpaceSidebarError,
    type SidebarDiagnostic,
    type SpaceSidebarDocument,
} from "@slopus/happy-agent-client";
import { ArtifactInputError } from "./Artifact.js";

export type { SidebarDiagnostic };

/** A sidebar document or operation the grammar refuses, with diagnostics for the writer. */
export class SidebarValidationError extends ArtifactInputError {
    readonly diagnostics: SidebarDiagnostic[];
    /** The zero-based operation of a batch that could not apply, when one did not. */
    readonly operationIndex: number | undefined;

    constructor(message: string, offset = 0, operationIndex?: number) {
        super(message);
        this.diagnostics = [{ message, offset }];
        this.operationIndex = operationIndex;
    }

    static from(error: SpaceSidebarError): SidebarValidationError {
        const refused = new SidebarValidationError(
            error.message,
            error.diagnostics[0]?.offset ?? 0,
            "operationIndex" in error ? (error.operationIndex as number) : undefined,
        );
        refused.diagnostics.splice(0, refused.diagnostics.length, ...error.diagnostics);
        return refused;
    }
}

/**
 * The sidebar's text read with the client's parser, the one every client uses, so the daemon
 * accepts exactly the documents clients draw.
 */
export function readSidebarDocument(html: string): SpaceSidebarDocument {
    try {
        return parseSpaceSidebar(html);
    } catch (error: unknown) {
        if (error instanceof SpaceSidebarError) throw SidebarValidationError.from(error);
        throw error;
    }
}
