#!/usr/bin/env node
/** Entry for the `a2app` binary: the A2App protocol client (spec section 5.1).
 *  Operate only — a build command must never be routed here. */
import { dispatch } from "./cli.js";

dispatch("a2app");
