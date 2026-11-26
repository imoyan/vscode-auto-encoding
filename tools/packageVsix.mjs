import { createVSIX } from "@vscode/vsce";

await createVSIX({ dependencies: false });
