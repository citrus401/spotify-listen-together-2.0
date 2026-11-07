
export default {
  hostPassword: process.env.HOST_PASSWORD || "1234",
  maxDelay: parseInt(process.env.MAX_DELAY!) || 5000,
  // how often listeners get the expected position to fix drift, ms
  syncInterval: parseInt(process.env.SYNC_INTERVAL!) || 3000,
  // 0.5 clients still work, they just ignore syncPosition. 0.7 = rooms changed, the server protocol didn't
  clientVersionRequirements: ">=0.5.0 <0.8.0",
  clientRecommendedVersion: "0.5.0"
}
