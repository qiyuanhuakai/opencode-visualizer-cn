export interface FileTypeInfo {
  type: string;
  description: string;
  details?: string;
}

const ELF_MACHINES: Record<number, string> = {
  0x00: 'No specific instruction set',
  0x01: 'AT&T WE 32100',
  0x02: 'SPARC',
  0x03: 'x86',
  0x04: 'Motorola 68000 (M68k)',
  0x05: 'Motorola 88000 (M88k)',
  0x06: 'Intel MCU',
  0x07: 'Intel 80860',
  0x08: 'MIPS',
  0x09: 'IBM System/370',
  0x0A: 'MIPS RS3000 Little-endian',
  0x0B: 'RS6000',
  0x0E: 'HP PA-RISC',
  0x13: 'Intel 80960',
  0x14: 'PowerPC',
  0x15: 'PowerPC (64-bit)',
  0x16: 'S390 (including S390x)',
  0x17: 'IBM SPU/SPC',
  0x24: 'NEC V800',
  0x25: 'Fujitsu FR20',
  0x26: 'TRW RH-32',
  0x27: 'Motorola RCE',
  0x28: 'ARM (32-bit)',
  0x29: 'Digital Alpha',
  0x2A: 'SuperH',
  0x2B: 'SPARC Version 9',
  0x2C: 'Siemens TriCore embedded processor',
  0x2D: 'Argonaut RISC Core',
  0x2E: 'Hitachi H8/300',
  0x2F: 'Hitachi H8/300H',
  0x30: 'Hitachi H8S',
  0x31: 'Hitachi H8/500',
  0x32: 'IA-64',
  0x33: 'Stanford MIPS-X',
  0x34: 'Motorola ColdFire',
  0x35: 'Motorola M68HC12',
  0x36: 'Fujitsu MMA Multimedia Accelerator',
  0x37: 'Siemens PCP',
  0x38: 'Sony nCPU embedded RISC processor',
  0x39: 'Denso NDR1 microprocessor',
  0x3A: 'Motorola Star*Core processor',
  0x3B: 'Toyota ME16 processor',
  0x3C: 'STMicroelectronics ST100 processor',
  0x3D: 'Advanced Logic Corp. TinyJ embedded processor family',
  0x3E: 'x86-64',
  0x8C: 'TMS320C6000 family',
  0xAF: 'Renesas RX',
  0xB7: 'AArch64 (ARM 64-bit)',
  0xDC: 'Zilog Z80',
  0xF3: 'RISC-V',
  0xF7: 'Berkeley Packet Filter',
  0x101: 'WDC 65C816',
};

const ELF_TYPES: Record<number, string> = {
  0x00: 'NONE (Unknown)',
  0x01: 'REL (Relocatable file)',
  0x02: 'EXEC (Executable file)',
  0x03: 'DYN (Shared object)',
  0x04: 'CORE (Core dump)',
};

const ELF_OS_ABIS: Record<number, string> = {
  0x00: 'System V',
  0x01: 'HP-UX',
  0x02: 'NetBSD',
  0x03: 'Linux',
  0x04: 'GNU Hurd',
  0x06: 'Solaris',
  0x07: 'AIX',
  0x08: 'IRIX',
  0x09: 'FreeBSD',
  0x0A: 'Tru64',
  0x0B: 'Novell Modesto',
  0x0C: 'OpenBSD',
  0x0D: 'OpenVMS',
  0x0E: 'NonStop Kernel',
  0x0F: 'AROS',
  0x10: 'Fenix OS',
  0x11: 'CloudABI',
  0x12: 'Stratus Technologies OpenVOS',
};

const PE_MACHINES: Record<number, string> = {
  0x014c: 'x86 (I386)',
  0x0162: 'MIPS R3000',
  0x0166: 'MIPS R4000',
  0x0168: 'MIPS R10000',
  0x0169: 'MIPS WCE v2',
  0x0184: 'Alpha AXP',
  0x01a2: 'SH3',
  0x01a3: 'SH3 DSP',
  0x01a4: 'SH4',
  0x01a6: 'SH5',
  0x01c0: 'ARM',
  0x01c2: 'ARM Thumb',
  0x01c4: 'ARMv7 (Thumb-2)',
  0x01d3: 'AM33',
  0x01f0: 'PowerPC',
  0x01f1: 'PowerPC with FP',
  0x0200: 'IA-64 (Itanium)',
  0x0266: 'MIPS16',
  0x0284: 'Alpha AXP (64-bit)',
  0x0366: 'MIPS with FPU',
  0x0466: 'MIPS16 with FPU',
  0x0ebc: 'EFI Byte Code',
  0x8664: 'x86-64 (AMD64)',
  0x9041: 'Mitsubishi M32R',
  0xaa64: 'ARM64 (AArch64)',
  0xc0ee: 'CEF',
};

export function detectFileType(bytes: Uint8Array): FileTypeInfo | null {
  if (!bytes || bytes.length < 4) return null;

  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return parseElfHeader(bytes);
  }

  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return parsePeHeader(bytes);
  }

  const machoMagic = readUint32(bytes, 0);
  if (machoMagic === 0xfeedface || machoMagic === 0xfeedfacf ||
      machoMagic === 0xcefaedfe || machoMagic === 0xcffaedfe) {
    return parseMachoHeader(bytes);
  }

  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { type: 'PNG', description: 'Portable Network Graphics image' };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: 'JPEG', description: 'JPEG image' };
  }

  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { type: 'GIF', description: 'Graphics Interchange Format image' };
  }

  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return { type: 'RIFF', description: 'RIFF container (AVI/WAV/WEBP)' };
  }

  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { type: 'ZIP', description: 'ZIP archive (DOCX/XLSX/PPTX/JAR/APK)' };
  }

  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { type: 'GZIP', description: 'GZIP compressed file' };
  }

  if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return { type: 'BZIP2', description: 'BZIP2 compressed file' };
  }

  if (bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58) {
    return { type: 'XZ', description: 'XZ compressed file' };
  }

  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { type: 'PDF', description: 'Portable Document Format' };
  }

  // ICNS: magic bytes 'icns' (0x69 0x63 0x6e 0x73)
  if (bytes[0] === 0x69 && bytes[1] === 0x63 && bytes[2] === 0x6e && bytes[3] === 0x73) {
    return { type: 'ICNS', description: 'Apple Icon Image' };
  }

  // ICO: magic bytes 0x00 0x00 0x01 0x00 (or 0x00 0x00 0x02 0x00 for CUR)
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 &&
      (bytes[2] === 0x01 || bytes[2] === 0x02) && bytes[3] === 0x00) {
    return { type: 'ICO', description: bytes[2] === 0x01 ? 'Windows Icon' : 'Windows Cursor' };
  }

  // SVG: starts with <?xml or <svg (after optional BOM or whitespace)
  const svgSignature = detectSvg(bytes);
  if (svgSignature) {
    return svgSignature;
  }

  let printableCount = 0;
  const sampleSize = Math.min(bytes.length, 512);
  for (let i = 0; i < sampleSize; i++) {
    const b = bytes[i];
    if ((b >= 32 && b < 127) || b === 0x09 || b === 0x0a || b === 0x0d) {
      printableCount++;
    }
  }
  if (printableCount / sampleSize > 0.9) {
    return { type: 'TEXT', description: 'Plain text file' };
  }

  return { type: 'BINARY', description: 'Unknown binary file' };
}

function detectSvg(bytes: Uint8Array): FileTypeInfo | null {
  let offset = 0;
  // Skip UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  }
  // Skip leading whitespace
  while (offset < bytes.length && (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d)) {
    offset += 1;
  }
  const remaining = bytes.length - offset;
  if (remaining < 4) return null;
  // Check for <?xml
  if (bytes[offset] === 0x3c && bytes[offset + 1] === 0x3f && bytes[offset + 2] === 0x78 && bytes[offset + 3] === 0x6d) {
    return { type: 'SVG', description: 'Scalable Vector Graphics' };
  }
  // Check for <svg
  if (remaining >= 4 && bytes[offset] === 0x3c && bytes[offset + 1] === 0x73 && bytes[offset + 2] === 0x76 && bytes[offset + 3] === 0x67) {
    return { type: 'SVG', description: 'Scalable Vector Graphics' };
  }
  return null;
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean = true): number {
  if (littleEndian) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian: boolean = true): number {
  if (littleEndian) {
    return bytes[offset] | (bytes[offset + 1] << 8) |
           (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  }
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
         (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function parseElfHeader(bytes: Uint8Array): FileTypeInfo {
  const is64Bit = bytes[4] === 2;
  const littleEndian = bytes[5] === 1;
  const osAbi = bytes[7];
  const type = readUint16(bytes, 16, littleEndian);
  const machine = readUint16(bytes, 18, littleEndian);

  const classStr = is64Bit ? '64-bit' : '32-bit';
  const endianStr = littleEndian ? 'LSB' : 'MSB';
  const typeStr = ELF_TYPES[type] || `Unknown (0x${type.toString(16)})`;
  const machineStr = ELF_MACHINES[machine] || `Unknown (0x${machine.toString(16)})`;
  const osAbiStr = ELF_OS_ABIS[osAbi] || `Unknown (0x${osAbi.toString(16)})`;

  let pieInfo = '';
  if (type === 0x03) {
    pieInfo = 'PIE executable';
  } else if (type === 0x02) {
    pieInfo = 'static executable';
  }

  return {
    type: 'ELF',
    description: `ELF ${classStr} ${endianStr} ${typeStr.split(' ')[0].toLowerCase()}`,
    details: `${machineStr}${pieInfo ? ', ' + pieInfo : ''}, ${osAbiStr}`,
  };
}

function parsePeHeader(bytes: Uint8Array): FileTypeInfo {
  if (bytes.length < 0x40) {
    return { type: 'PE', description: 'Windows executable (MS-DOS stub only)' };
  }

  const peOffset = readUint32(bytes, 0x3c, true);
  if (peOffset < 0x40 || peOffset + 24 > bytes.length) {
    return { type: 'PE', description: 'Windows executable (invalid PE header)' };
  }

  if (bytes[peOffset] !== 0x50 || bytes[peOffset + 1] !== 0x45 ||
      bytes[peOffset + 2] !== 0x00 || bytes[peOffset + 3] !== 0x00) {
    return { type: 'PE', description: 'Windows executable (MS-DOS program)' };
  }

  const coffOffset = peOffset + 4;
  const machine = readUint16(bytes, coffOffset, true);
  const characteristics = readUint16(bytes, coffOffset + 18, true);

  const machineStr = PE_MACHINES[machine] || `Unknown (0x${machine.toString(16)})`;
  const isDll = (characteristics & 0x2000) !== 0;
  const isExecutable = (characteristics & 0x0002) !== 0;

  let typeStr = 'Unknown';
  if (isDll) {
    typeStr = 'DLL (Dynamic Link Library)';
  } else if (isExecutable) {
    typeStr = 'Executable';
  }

  return {
    type: 'PE',
    description: `Windows ${typeStr}`,
    details: machineStr,
  };
}

function parseMachoHeader(bytes: Uint8Array): FileTypeInfo {
  const magic = readUint32(bytes, 0, true);
  const is64Bit = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const isLittleEndian = magic === 0xcffaedfe || magic === 0xcefaedfe;

  const cputype = readUint32(bytes, 4, isLittleEndian);
  const filetype = readUint32(bytes, 12, isLittleEndian);

  let arch = 'Unknown';
  switch (cputype) {
    case 0x00000007: arch = 'x86'; break;
    case 0x01000007: arch = 'x86-64'; break;
    case 0x0000000c: arch = 'ARM'; break;
    case 0x0100000c: arch = 'ARM64'; break;
    case 0x00000012: arch = 'PowerPC'; break;
    case 0x01000012: arch = 'PowerPC 64'; break;
  }

  let fileTypeStr = 'Unknown';
  switch (filetype) {
    case 0x00000002: fileTypeStr = 'Executable'; break;
    case 0x00000003: fileTypeStr = 'Fixed VM Shared Library'; break;
    case 0x00000006: fileTypeStr = 'Dynamic Shared Library'; break;
    case 0x00000008: fileTypeStr = 'Dynamic Linker'; break;
    case 0x00000009: fileTypeStr = 'Bundle'; break;
  }

  return {
    type: 'Mach-O',
    description: `Mach-O ${is64Bit ? '64-bit' : '32-bit'} ${fileTypeStr.toLowerCase()}`,
    details: arch,
  };
}
