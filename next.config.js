// @ts-check
const path = require("path");

// When nested inside another Next.js project, Next.js workspace-root detection
// points cwd at the parent. __dirname in CJS always resolves to this file's
// directory, so we prepend the stub's node_modules to webpack's search path.
const stubModules = path.join(__dirname, "node_modules");

/** @type {import('next').NextConfig} */
const config = {
  outputFileTracingRoot: __dirname,
  async headers() {
    return [
      {
        source: '/.well-known/openai-apps-challenge',
        headers: [
          { key: 'Content-Type', value: 'text/plain' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
      {
        // B-492: the /mcp server card is prerendered and has no OPTIONS handler (that
        // would make it dynamic), so its CORS headers live here and cover GET + OPTIONS.
        // Values unchanged from the former hand-written card.
        source: '/.well-known/mcp/server-card.json',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
        ],
      },
    ];
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.modules = [
      stubModules,
      ...(webpackConfig.resolve.modules || ["node_modules"]),
    ];
    return webpackConfig;
  },
};

module.exports = config;
