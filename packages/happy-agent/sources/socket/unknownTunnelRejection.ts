import type { ApiSocketRejection } from "@slopus/happy-agent-modules";

/**
 * The answer to a `CONNECT` no tunnel route claims. It is refused like any unknown route, with the
 * JSON error envelope, and the connection closes: a tunnel request cannot continue as ordinary HTTP.
 */
export const unknownTunnelRejection: ApiSocketRejection = {
    code: "not_found",
    message: "The requested endpoint does not exist.",
    status: 404,
};
