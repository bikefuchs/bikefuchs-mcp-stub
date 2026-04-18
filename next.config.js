// @ts-check
const path = require("path");

// When nested inside another Next.js project, Next.js workspace-root detection
// points cwd at the parent. __dirname in CJS always resolves to this file's
// directory, so we prepend the stub's node_modules to webpack's search path.
const stubModules = path.join(__dirname, "node_modules");

/** @type {import('next').NextConfig} */
const config = {
  outputFileTracingRoot: __dirname,
  webpack: (webpackConfig) => {
    webpackConfig.resolve.modules = [
      stubModules,
      ...(webpackConfig.resolve.modules || ["node_modules"]),
    ];
    return webpackConfig;
  },
};

module.exports = config;
