import { z } from 'zod';
const numeric = z.number().finite().nonnegative();
const temperatureNumber = z.number().finite().min(-30).max(150).nullable().optional();
const optionalNumber = z.number().finite().nullable().optional();
export const snapshotSchema = z.object({
  deviceId: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  sampledAt: z.string().datetime({ offset: true }),
  hostname: z.string().max(120), os: z.string().max(180), cpuName: z.string().max(180),
  cpuCores: z.number().int().min(1).max(2048), cpuPercent: numeric.max(100), temperatureC: temperatureNumber,
  temperatureSource: z.string().max(150).nullable().optional(),
  memoryTotalBytes: numeric, memoryUsedBytes: numeric, diskTotalBytes: numeric, diskUsedBytes: numeric, diskFreeBytes: numeric,
  uptimeSeconds: numeric, powerProfile: z.string().max(40),
  battery: z.object({ percent: optionalNumber, status: z.string().max(30), powerW: optionalNumber, fullWh: optionalNumber,
    designWh: optionalNumber, energyWh: optionalNumber, healthPercent: optionalNumber, remainingHours: optionalNumber }).nullable(),
  gpu: z.object({ name: z.string().max(150), state: z.string().max(50), mode: z.string().max(40), runtimeStatus: z.string().max(40).optional(),
    driverLoaded: z.boolean().optional(), utilization: optionalNumber, temperatureC: temperatureNumber, powerW: optionalNumber,
    temperatureSource: z.string().max(150).nullable().optional(),
    powerLimitW: optionalNumber, memoryUsedMb: optionalNumber, memoryTotalMb: optionalNumber,
    sampledAt: z.string().max(60).optional() }).nullable(),
  network: z.object({ rxBytesPerSecond: numeric, txBytesPerSecond: numeric }),
  processCount: numeric.max(100000),
  processes: z.array(z.object({ pid: z.number().int().positive(), name: z.string().max(120), user: z.string().max(80),
    cpuPercent: numeric.max(204800), memoryBytes: numeric, memoryPercent: numeric.max(100), state: z.string().max(4) })).max(250),
});
