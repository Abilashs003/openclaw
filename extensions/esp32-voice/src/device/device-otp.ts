/**
 * Device OTP (One-Time Password) pairing system.
 *
 * During onboarding, the user gets a 6-digit OTP code displayed in their terminal.
 * The ESP32 device sends this OTP during its initial hello handshake to pair itself.
 * Once verified, the device is added to the trusted devices list in config.
 */

import crypto from "node:crypto";

interface PendingOtp {
  code: string;
  deviceId?: string;
  createdAt: number;
  expiresAt: number;
}

interface PairedDevice {
  deviceId: string;
  deviceToken: string;
  pairedAt: string;
  name?: string;
}

const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

class DeviceOtpManager {
  /** Pending OTPs waiting for device activation. */
  private pendingOtps = new Map<string, PendingOtp>();

  /** Active paired devices (in-memory, synced to config). */
  private pairedDevices = new Map<string, PairedDevice>();

  /**
   * Generate a new OTP for device pairing.
   *
   * @returns The OTP code to display to the user.
   */
  generateOtp(deviceId?: string): string {
    // Generate a cryptographically secure 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();

    const otp: PendingOtp = {
      code,
      deviceId,
      createdAt: Date.now(),
      expiresAt: Date.now() + OTP_EXPIRY_MS,
    };

    this.pendingOtps.set(code, otp);

    // Clean up expired OTPs
    this.cleanupExpired();

    console.log(`[device-otp] Generated OTP: ${code} (expires in 5 minutes)`);
    return code;
  }

  /**
   * Verify an OTP from a device and complete pairing.
   *
   * @param code - The OTP code sent by the device.
   * @param deviceId - The device's self-reported ID.
   * @returns The device token to use for future authentication, or null if invalid.
   */
  verifyOtp(code: string, deviceId: string): { deviceToken: string; paired: PairedDevice } | null {
    this.cleanupExpired();

    const pending = this.pendingOtps.get(code);
    if (!pending) {
      console.warn(`[device-otp] Invalid OTP: ${code}`);
      return null;
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingOtps.delete(code);
      console.warn(`[device-otp] Expired OTP: ${code}`);
      return null;
    }

    // OTP is valid — generate a permanent device token
    const deviceToken = crypto.randomBytes(32).toString("hex");

    const paired: PairedDevice = {
      deviceId,
      deviceToken,
      pairedAt: new Date().toISOString(),
    };

    this.pairedDevices.set(deviceId, paired);
    this.pendingOtps.delete(code);

    console.log(`[device-otp] Device "${deviceId}" paired successfully`);
    return { deviceToken, paired };
  }

  /**
   * Check if a device is paired.
   */
  isPaired(deviceId: string): boolean {
    return this.pairedDevices.has(deviceId);
  }

  /**
   * Authenticate a device by its token.
   *
   * @returns The device ID if valid, null otherwise.
   */
  authenticateToken(token: string): string | null {
    for (const [deviceId, paired] of this.pairedDevices) {
      if (paired.deviceToken === token) {
        return deviceId;
      }
    }
    return null;
  }

  /**
   * Get all paired devices.
   */
  listPairedDevices(): PairedDevice[] {
    return [...this.pairedDevices.values()];
  }

  /**
   * Remove a paired device.
   */
  unpairDevice(deviceId: string): boolean {
    return this.pairedDevices.delete(deviceId);
  }

  /**
   * Load paired devices from config (call on startup).
   */
  loadFromConfig(devices: Record<string, { deviceToken: string; name?: string }>): void {
    for (const [deviceId, config] of Object.entries(devices)) {
      this.pairedDevices.set(deviceId, {
        deviceId,
        deviceToken: config.deviceToken,
        pairedAt: "config",
        name: config.name,
      });
    }
    console.log(`[device-otp] Loaded ${this.pairedDevices.size} paired device(s) from config`);
  }

  /**
   * Export paired devices for writing to config.
   */
  exportForConfig(): Record<string, { deviceToken: string; name?: string }> {
    const result: Record<string, { deviceToken: string; name?: string }> = {};
    for (const [deviceId, paired] of this.pairedDevices) {
      result[deviceId] = {
        deviceToken: paired.deviceToken,
        ...(paired.name ? { name: paired.name } : {}),
      };
    }
    return result;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [code, otp] of this.pendingOtps) {
      if (now > otp.expiresAt) {
        this.pendingOtps.delete(code);
      }
    }
  }
}

/** Global device OTP manager. */
export const deviceOtpManager = new DeviceOtpManager();
