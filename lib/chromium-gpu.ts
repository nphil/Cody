/**
 * How Cody asks Chromium for the GPU, in one place.
 *
 * Two unrelated subsystems spawn Chromium: the display providers
 * (`lib/display/`, via puppeteer, for the streamed preview) and the one-shot
 * screenshot capture (`lib/preview-screenshot.ts`, via the `--screenshot` CLI).
 * They must agree about the flags and about how a GPU is detected, because a
 * host where one of them gets hardware and the other silently falls to
 * SwiftShader is indistinguishable from a bug in the page being rendered.
 *
 * This module exists rather than the screenshot path importing the provider
 * because that path is deliberately lean — it is reached from an API route and
 * must not drag puppeteer-core into the request. Nothing here imports anything.
 */

/**
 * No GPU: rasterize and composite on the CPU. Portable, correct on every host,
 * and the only honest choice when no render node was passed into the container.
 */
export const CHROMIUM_SOFTWARE_ARGS = ["--disable-gpu"];
/**
 * GPU rasterization, used only when the boot probe found a DRM render node.
 * Every name here was verified against the Chromium this image ships
 * (151.0.7922.137, Debian bookworm); these switches have churned and a wrong
 * one fails silently, because Chromium never rejects an unknown flag.
 *
 * `--use-gl=angle`   ANGLE is the only GL implementation this build allows. Any
 *                    other value logs `Requested GL implementation
 *                    (gl=egl-gles2, angle=none) not found in allowed
 *                    implementations: [(gl=egl-angle,angle=default)]` and drops
 *                    to software. Note the widely-copied `--use-gl=egl` is that
 *                    rejected case, not an alias for this.
 * `--use-angle=gl-egl`
 *                    Desktop GL through EGL. ANGLE's `default` backend tries
 *                    GLX first and dies with `Could not open the default X
 *                    display` in a headless container; `gl-egl` goes straight to
 *                    Mesa's EGL and needs no X server.
 * `--enable-gpu-rasterization`
 *                    Moves tile raster onto the GPU, off the CPU that is already
 *                    encoding every frame to JPEG — the actual win here.
 * `--ignore-gpu-blocklist`
 *                    Chromium blocklists most Mesa-in-a-container configurations,
 *                    so without this the flags above are accepted and then
 *                    overruled. (`--ignore-gpu-blacklist` is the old spelling and
 *                    no longer exists.)
 *
 * Requires libEGL.so.1 in the image: ANGLE dlopens the NATIVE EGL, and
 * Chromium's bundled /usr/lib/chromium/libEGL.so is its own front-end, not a
 * driver. docker/Dockerfile installs libegl1 + libegl-mesa0 for exactly this;
 * without them the GPU process logs `Could not dlopen native EGL: libEGL.so.1`.
 */
export const CHROMIUM_GPU_ARGS = ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"];
/**
 * Substrings that mark a SOFTWARE GL renderer. Needed because Chromium's own
 * feature table cannot be trusted for this question: measured on this image with
 * the GPU flags but no render node, `SystemInfo.getInfo` reported
 * `rasterization: enabled_force` and `gpu_compositing: enabled` while
 * `glRenderer` read `ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.6 256 bits), …)`.
 * That is CPU rasterization wearing a hardware label, and it is slower than the
 * software path we would otherwise take — so `glRenderer` is the field we
 * believe, and a match here counts as a failed GPU launch.
 */
export const SOFTWARE_RENDERERS = ["llvmpipe", "swiftshader", "softpipe", "swrast"];

/**
 * The DRM render node `docker/entrypoint.sh` found at boot, or null. Taken from
 * the environment rather than probed here so there is exactly one detector in
 * the system — and so the desktop shells, which never run that entrypoint, stay
 * on the software path by simply leaving the variable unset.
 */
export function gpuRenderNode(): string | null {
  const node = process.env.CODY_GPU_RENDER_NODE?.trim();
  return node ? node : null;
}
