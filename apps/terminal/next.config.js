const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@kydo/sdk", "@kydo/ui"],
  experimental: {
    // the SDK is consumed from its TypeScript source (../../packages/sdk/src)
    externalDir: true,
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@kydo/sdk": path.resolve(__dirname, "../../packages/sdk/src/index.ts"),
      "@kydo/ui$": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
    };
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      fs: false,
      path: false,
      os: false,
    };
    if (!isServer) {
      // wallet-adapter pulls optional RN deps
      config.resolve.fallback["react-native-async-storage"] = false;
    }
    config.externals = [...(config.externals ?? []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

module.exports = nextConfig;
