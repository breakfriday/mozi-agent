import type { SessionSnapshot } from "../../../../shared/agent";
import type { RuntimeSessionDescriptor } from "../runtime/agent-runtime";
import type { MessageLink } from "../storage/metadata";

/** Memory-only projection. Never passed to the metadata store. */
export interface SessionRecord {
  descriptor: RuntimeSessionDescriptor;
  snapshot: SessionSnapshot;
  messageLinks: MessageLink[];
}
