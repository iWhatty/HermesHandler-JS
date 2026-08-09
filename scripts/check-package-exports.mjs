import * as packageRoot from "hermes-handler";
import * as packageClient from "hermes-handler/client";

if (packageRoot.createHermesClient !== packageClient.createHermesClient) {
    throw new Error("Package root must re-export createHermesClient from ./client.");
}

if (typeof packageRoot.HermesHandler !== "function") {
    throw new Error("Package root must export HermesHandler.");
}
