import fs from "node:fs";
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (fs.existsSync(chromePath)) {
  Config.setBrowserExecutable(chromePath);
}
