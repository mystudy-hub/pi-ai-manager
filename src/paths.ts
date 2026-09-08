import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function settingsDirectory(): string {
	return join(getAgentDir(), "extension-settings");
}
