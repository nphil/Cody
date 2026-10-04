import { hashBlob } from "./blob-stream";
import { FirehoseSession, type FirehoseConfiguration, type FirehoseStorage } from "./edl-firehose";
import { EdlError, EdlLink, edlTimeouts } from "./edl-link";
import {
  awaitHello,
  looksLikeSaharaHello,
  resetSaharaStateMachine,
  saharaIdentify,
  saharaUpload,
  type SaharaHello,
  type SaharaIdentity,
  type SaharaUploadResult,
} from "./edl-sahara";
import type { HardwareContext, HardwareRequest, HardwareRisk } from "./flasher";
import { throwIfAborted } from "./serial";

/**
 * Getting a talking Firehose programmer out of whatever state the device is in.
 *
 * A device in emergency download is either still in the boot ROM (Sahara,
 * waiting for a loader) or already running one (Firehose). It may also have been
 * left half-way by an earlier operation: the page keeps no memory of it, so every
 * operation starts by finding out. The order matters because the probes are not
 * equally harmless to both: a Firehose `nop` is ignored by a programmer but
 * refused by a boot ROM, and a Sahara restart packet is the boot ROM's own way to
 * start over.
 */

/** Largest loader Cody will hand to a boot ROM. The reference loader for this family is about 375 KB. */
const MAX_LOADER_BYTES = 16 * 1024 * 1024;
/** Longest stretch of unexpected data discarded while looking for something to talk to. */
const MAX_RESYNC_BYTES = 16 * 1024 * 1024;

export type Discovered =
  | { readonly kind: "sahara"; readonly hello: SaharaHello }
  | { readonly kind: "firehose" };

function hexHead(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function startsLikeXml(bytes: Uint8Array): boolean {
  return /^\s*<(?:\?xml|data|log|response)/.test(new TextDecoder("latin1").decode(bytes.subarray(0, 64)));
}

export interface EdlRun {
  readonly context: HardwareContext;
  readonly request: HardwareRequest;
  /** One line for the operation's output. */
  say(line: string): void;
}

/**
 * Works out what is on the other end. Returns a Sahara HELLO to answer, or says a
 * programmer is answering. Never sends anything the programmer would act on.
 */
async function discover(link: EdlLink, run: EdlRun): Promise<Discovered> {
  const { say } = run;
  // A zero-length packet is not silence: wait for bytes, or for the first-contact time to run out.
  const firstContactEnds = Date.now() + edlTimeouts.firstContact;
  while (link.buffered === 0 && Date.now() < firstContactEnds) {
    if ((await link.pull(firstContactEnds - Date.now())) === null) break;
  }
  if (link.buffered > 0) {
    const head = link.view();
    if (looksLikeSaharaHello(head)) {
      const hello = await awaitHello(link, edlTimeouts.packet, "Sahara HELLO");
      say(`The boot ROM is waiting: Sahara version ${hello.version}.`);
      return { kind: "sahara", hello };
    }
    if (startsLikeXml(head)) {
      say("A Firehose programmer is already running on the device.");
      return { kind: "firehose" };
    }
    say(`The device sent something unexpected first (${hexHead(head)}); discarding it and looking again.`);
    await link.drain(150, MAX_RESYNC_BYTES);
  }
  // Quiet: ask a programmer if it is there, then ask a boot ROM to start over.
  const asker = new FirehoseSession(link, say);
  if (await asker.probe(edlTimeouts.probe)) {
    say("A Firehose programmer answered.");
    return { kind: "firehose" };
  }
  const stale = link.buffered;
  await link.drain(150, MAX_RESYNC_BYTES);
  say(stale > 0 ? "The device answered with binary data, which a boot ROM does when it is not expecting a command; asking it to start over." : "The device is quiet; asking a boot ROM to start over.");
  await resetSaharaStateMachine(link);
  try {
    const hello = await awaitHello(link, edlTimeouts.probe, "Sahara restart");
    say(`The boot ROM started over: Sahara version ${hello.version}.`);
    return { kind: "sahara", hello };
  } catch (error) {
    if (!(error instanceof EdlError) || error.kind === "refused") throw error;
    throw new EdlError(
      "The device does not answer as a Firehose programmer or as a Sahara boot ROM. Unplug it and put it into EDL mode again (power it off, then hold the EDL button or short the test point while connecting USB), then try again.",
      "timeout",
    );
  }
}

export interface LoaderInfo {
  readonly sha256: string;
  readonly bytes: number;
  readonly looksLikeElf: boolean;
}

export async function inspectLoader(loader: Blob | undefined): Promise<LoaderInfo | undefined> {
  if (!loader) return undefined;
  if (loader.size <= 0) throw new EdlError("The loader file is empty.", "refused");
  if (loader.size > MAX_LOADER_BYTES) throw new EdlError(`The loader file is ${loader.size} bytes; Cody sends loaders up to ${MAX_LOADER_BYTES}.`, "refused");
  const magic = new Uint8Array(await loader.slice(0, 4).arrayBuffer());
  return { sha256: await hashBlob(loader), bytes: loader.size, looksLikeElf: magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46 };
}

function loaderRisk(request: HardwareRequest, loader: LoaderInfo, identity: SaharaIdentity | undefined): HardwareRisk {
  return {
    action: "edl load programmer",
    // A confirmation must carry the request's own target and byte range; the loader itself is identified by its digest.
    target: request.target ?? "programmer",
    ...(request.offset === undefined ? {} : { offset: request.offset }),
    ...(request.length === undefined ? {} : { length: request.length }),
    sha256: loader.sha256,
    backup: "Not applicable: the programmer runs from the device's RAM and Cody writes nothing to storage in this step. The programmer is unrestricted code once it runs - load only a loader you trust.",
    details: [
      `Send the ${loader.bytes}-byte file with SHA-256 ${loader.sha256} to the device's boot ROM and run it there.`,
      loader.looksLikeElf ? "The file starts like an ELF image, as Qualcomm programmers do." : "WARNING: the file does not start like an ELF image; the boot ROM will almost certainly reject it.",
      identity ? `Device: chip serial ${identity.serial}${identity.msmId ? `, hardware id ${identity.hardwareId}` : ""}${identity.pkHash ? `, public-key hash ${identity.pkHash}` : ""}.` : "Device identity was not read.",
      "The boot ROM checks the loader's signature itself; a loader signed for another device is refused and nothing runs.",
    ].join("\n"),
  };
}

export interface OpenedEdl {
  readonly link: EdlLink;
  readonly firehose: FirehoseSession;
  readonly configuration: FirehoseConfiguration;
  readonly storage: FirehoseStorage;
  /** Read from the boot ROM in this same operation; absent when a programmer was already running. */
  readonly identity: SaharaIdentity | undefined;
  /** The loader that was sent in this operation, when one was. */
  readonly loader: LoaderInfo | undefined;
  readonly upload: SaharaUploadResult | undefined;
}

export interface OpenSpec {
  /** `require`: the boot ROM's identity is part of what the operation needs, so a programmer that is already running is refused. */
  readonly identity: "skip" | "try" | "require";
  /**
   * `never`: this operation does not send a loader. A device still waiting in the boot ROM is refused, before the
   * boot ROM is spoken to, with the way to get a programmer running first (Connect). The file such an operation
   * carries is its own (an image), never a loader.
   */
  readonly loader?: "never";
  /**
   * Called with the boot ROM's identity as soon as it has been read, BEFORE any loader is confirmed or sent;
   * throw to stop there. Not called when the identity could not be read.
   */
  readonly checkIdentity?: (identity: SaharaIdentity) => void;
}

export function describeIdentity(identity: SaharaIdentity): string[] {
  return [
    `Chip serial number: 0x${identity.serial}`,
    identity.hardwareId ? `Hardware id: 0x${identity.hardwareId} (MSM 0x${identity.msmId}, OEM 0x${identity.oemId}, model 0x${identity.modelId})` : "Hardware id: not available",
    identity.pkHash ? `OEM public-key hash (${identity.pkHashBytes} bytes): ${identity.pkHash}` : "OEM public-key hash: not available",
  ];
}


/**
 * Opens a Firehose session for an operation: finds the device's state,
 * optionally reads its identity from the boot ROM, sends the user's loader
 * (after the user's confirmation) when the device still needs one, and
 * configures the programmer for eMMC. A programmer that is already running is
 * used as it is; the loader, if one was chosen, is not sent again.
 */
export async function openFirehose(run: EdlRun, spec: OpenSpec, loaderBlob: Blob | undefined): Promise<OpenedEdl> {
  const { context, request, say } = run;
  const link = new EdlLink(context.transport, context.signal);
  const loader = await inspectLoader(loaderBlob);
  let state = await discover(link, run);
  let identity: SaharaIdentity | undefined;
  let upload: SaharaUploadResult | undefined;
  let loaderSent: LoaderInfo | undefined;

  if (state.kind === "firehose" && spec.identity === "require") {
    throw new EdlError("A programmer is already running, so the boot ROM's identity (chip serial, hardware id, public-key hash) can no longer be read. Put the device into EDL mode again and repeat this.", "refused");
  }
  if (state.kind === "sahara" && spec.loader === "never") {
    throw new EdlError("The device is still waiting in the boot ROM. This operation never sends a loader itself: run Connect with the loader file first so a programmer is running, then repeat this. Nothing was changed.", "refused");
  }

  if (state.kind === "sahara") {
    if (spec.identity !== "skip") {
      context.progress({ phase: "identify", message: "Reading the boot ROM's identity" });
      try {
        const read = await saharaIdentify(link, state.hello, { consumeNextHello: true });
        identity = read;
        for (const line of describeIdentity(read)) say(line);
        for (const warning of read.warnings) say(`Note: ${warning}`);
        state = read.nextHello ? { kind: "sahara", hello: read.nextHello } : await discover(link, run);
      } catch (error) {
        if (!(error instanceof EdlError) || spec.identity === "require") throw error;
        say(`The boot ROM's identity could not be read (${error.message}); continuing without it.`);
        state = await discover(link, run);
      }
    }
    if (identity) spec.checkIdentity?.(identity);
    if (state.kind === "sahara") {
      if (!loaderBlob || !loader) {
        throw new EdlError("The device is waiting in the boot ROM and needs a programmer (loader) file. Choose the loader for this device in Files & backups, then run this again.", "refused");
      }
      await context.confirm(loaderRisk(request, loader, identity));
      throwIfAborted(context.signal);
      context.progress({ phase: "loader", completed: 0, total: loader.bytes, message: "Sending the loader to the boot ROM" });
      let lastReport = 0;
      upload = await saharaUpload(link, state.hello, loaderBlob, {
        progress: (sent, total) => {
          if (sent === total || Date.now() - lastReport > 250) {
            lastReport = Date.now();
            context.progress({ phase: "loader", completed: sent, total, message: "Sending the loader to the boot ROM" });
          }
        },
        note: say,
      });
      loaderSent = loader;
      say(`The boot ROM accepted the loader (${upload.requests} requests, ${upload.bytesSent} bytes).`);
      state = { kind: "firehose" };
    }
  } else if (loader) {
    say("A programmer is already running, so the chosen loader file was not sent.");
  }

  const firehose = new FirehoseSession(link, say);
  context.progress({ phase: "firehose", message: "Waiting for the programmer" });
  await firehose.start();
  if (firehose.chipSerial) say(`The programmer reports chip serial ${firehose.chipSerial}.`);
  const configuration = await firehose.configure();
  say(`Programmer configured: ${configuration.targetName ?? "unknown target"}, ${configuration.memoryName ?? "eMMC"}.`);
  const storage = await firehose.storageInfo();
  return { link, firehose, configuration, storage, identity, loader: loaderSent, upload };
}

export type DeviceInState =
  | { readonly kind: "sahara"; readonly link: EdlLink; readonly hello: SaharaHello }
  | { readonly kind: "firehose"; readonly link: EdlLink; readonly firehose: FirehoseSession };

/** Finds out what the device is doing and hands back the means to talk to it. */
export async function discoverDevice(run: EdlRun): Promise<DeviceInState> {
  const link = new EdlLink(run.context.transport, run.context.signal);
  const state = await discover(link, run);
  return state.kind === "sahara" ? { kind: "sahara", link, hello: state.hello } : { kind: "firehose", link, firehose: new FirehoseSession(link, run.say) };
}

/** Looks at the device without loading anything: the boot ROM's identity, or the running programmer's own account of itself. */
export async function inspectDevice(run: EdlRun): Promise<{ readonly identity: SaharaIdentity | undefined; readonly firehose: FirehoseSession | undefined }> {
  const found = await discoverDevice(run);
  if (found.kind === "sahara") return { identity: await saharaIdentify(found.link, found.hello, { consumeNextHello: false }), firehose: undefined };
  await found.firehose.start();
  return { identity: undefined, firehose: found.firehose };
}
