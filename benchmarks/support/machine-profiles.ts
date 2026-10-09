/**
 * Reviewed machine profiles for the scaled-scenario benchmark report.
 *
 * `cpuScore` is the PassMark single-thread rating retrieved on 2026-10-07 from cpubenchmark.net. Measured
 * endpoints run on one JavaScript thread, so the report scales their CPU-bound share by the single-thread
 * ratio. `cores` limits endpoints whose measured CPU time shows more than one busy CPU; memory size is not
 * modelled. PassMark ratings across ISAs, for burstable or shared vCPUs, and for hybrid efficiency cores, are
 * coarse.
 *
 * `ioLatencyUs` is a typical synchronous 4 KiB random-access latency at queue depth 1 for the profile's
 * default storage. Laptop values come from published SSD reviews for the interface generation; cloud values
 * come from the provider's documented latency class for its default system disk. They are estimates.
 */

/** One modelled machine with its CPU and default-storage performance. */
export interface MachineProfile {
  readonly id: string
  readonly label: string
  readonly cpu: string
  readonly cpuScore: number
  /** Logical CPUs: hardware threads on laptops, vCPUs on cloud instances. */
  readonly cores: number
  readonly storage: string
  readonly ioLatencyUs: number
  /** Lower-case substrings of `os.cpus()[0].model` that identify the measuring machine as this profile. */
  readonly cpuModelMatches?: readonly string[]
}

/** Profiles in report order. */
export const MACHINE_PROFILES: readonly MachineProfile[] = [
  { id: 'laptop-2015-win', label: '2015 Windows laptop', cpu: 'Intel Core i5-5200U', cpuScore: 1486, cores: 4, storage: 'SATA SSD', ioLatencyUs: 90 },
  { id: 'laptop-2015-mac', label: '2015 MacBook Pro 13"', cpu: 'Intel Core i5-5257U', cpuScore: 1737, cores: 4, storage: 'PCIe AHCI SSD', ioLatencyUs: 90 },
  { id: 'laptop-2019-win', label: '2019 Windows laptop', cpu: 'Intel Core i5-8265U', cpuScore: 2003, cores: 8, storage: 'NVMe PCIe 3.0 SSD', ioLatencyUs: 70 },
  { id: 'laptop-2023-win', label: '2023 Windows laptop', cpu: 'Intel Core i5-1335U', cpuScore: 3241, cores: 12, storage: 'NVMe PCIe 4.0 SSD', ioLatencyUs: 55 },
  { id: 'laptop-2023-mac', label: '2023 MacBook Air', cpu: 'Apple M2', cpuScore: 4208, cores: 8, storage: 'Apple SSD', ioLatencyUs: 55, cpuModelMatches: ['apple m2'] },
  { id: 'laptop-2026-win', label: '2026 Windows laptop', cpu: 'Intel Core Ultra 5 225H', cpuScore: 4247, cores: 14, storage: 'NVMe PCIe 4.0 SSD', ioLatencyUs: 50 },
  { id: 'laptop-2026-mac', label: '2026 MacBook', cpu: 'Apple M5', cpuScore: 6341, cores: 10, storage: 'Apple SSD', ioLatencyUs: 50, cpuModelMatches: ['apple m5'] },
  { id: 'aws-t3', label: 'AWS t3.medium', cpu: 'Intel Xeon Platinum 8259CL', cpuScore: 1948, cores: 2, storage: 'EBS gp3', ioLatencyUs: 500 },
  { id: 'aws-m6i', label: 'AWS m6i.large', cpu: 'Intel Xeon Platinum 8375C', cpuScore: 2474, cores: 2, storage: 'EBS gp3', ioLatencyUs: 500 },
  { id: 'aws-m7i', label: 'AWS m7i.large', cpu: 'Intel Xeon Platinum 8488C', cpuScore: 3113, cores: 2, storage: 'EBS gp3', ioLatencyUs: 500 },
  { id: 'aws-m7g', label: 'AWS m7g.large', cpu: 'AWS Graviton3 (Neoverse V1)', cpuScore: 1554, cores: 2, storage: 'EBS gp3', ioLatencyUs: 500 },
  { id: 'gcp-n2', label: 'GCP n2-standard-4', cpu: 'Intel Xeon Platinum 8273CL', cpuScore: 2200, cores: 4, storage: 'pd-balanced', ioLatencyUs: 800 },
  { id: 'azure-d4s-v5', label: 'Azure D4s v5', cpu: 'Intel Xeon Ice Lake (8375C rating)', cpuScore: 2474, cores: 4, storage: 'Premium SSD P10', ioLatencyUs: 1000 },
  { id: 'aliyun-g7', label: 'Alibaba Cloud ecs.g7.xlarge', cpu: 'Intel Xeon Ice Lake (8375C rating)', cpuScore: 2474, cores: 4, storage: 'ESSD PL0', ioLatencyUs: 400 },
  { id: 'github-ubuntu-24.04', label: 'GitHub ubuntu-24.04 runner', cpu: 'AMD EPYC 7763', cpuScore: 2517, cores: 2, storage: 'Azure managed disk', ioLatencyUs: 300, cpuModelMatches: ['epyc 7763'] },
  { id: 'github-ubuntu-24.04-genoa', label: 'GitHub ubuntu-24.04 runner (Genoa)', cpu: 'AMD EPYC 9V74', cpuScore: 2888, cores: 2, storage: 'Azure managed disk', ioLatencyUs: 300, cpuModelMatches: ['epyc 9v74'] },
  { id: 'reference-m4-pro', label: 'Calibration reference', cpu: 'Apple M4 Pro', cpuScore: 4547, cores: 14, storage: 'Apple SSD', ioLatencyUs: 55, cpuModelMatches: ['apple m4'] },
]

/**
 * Identify the measuring machine among the reviewed profiles.
 * @param cpuModel - `os.cpus()[0].model` of the machine that ran the benchmarks.
 * @returns the matching profile id, or `undefined` when no profile describes the machine.
 */
export function matchMachineProfile(cpuModel: string): string | undefined {
  const model = cpuModel.toLowerCase()
  return MACHINE_PROFILES.find(profile => profile.cpuModelMatches?.some(match => model.includes(match)) === true)?.id
}
