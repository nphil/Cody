import type { MetadataRoute } from "next";

// Served as /manifest.webmanifest (already on the auth proxy's public list —
// installability probes run signed-out). Colors are the dark theme's ground:
// the install splash and title bar should match the app's default look.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cody",
    short_name: "Cody",
    description: "A self-hosted web workspace for coding agents.",
    id: "/",
    start_url: "/",
    display: "standalone",
    background_color: "#1E1E2E",
    theme_color: "#1E1E2E",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
