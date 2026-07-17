import { execFile } from "node:child_process";

export type OfficeAutomationOperation =
  | "word-append"
  | "excel-write"
  | "powerpoint-add-slide";

export interface WordAppendRequest {
  operation: "word-append";
  text: string;
}

export interface ExcelWriteRequest {
  operation: "excel-write";
  startCell: string;
  content: string | readonly (readonly string[])[];
}

export interface PowerPointAddSlideRequest {
  operation: "powerpoint-add-slide";
  title: string;
  body: string;
}

export type OfficeAutomationRequest =
  | WordAppendRequest
  | ExcelWriteRequest
  | PowerPointAddSlideRequest;

export type OfficeAutomationResult =
  | {
      operation: "word-append";
      application: "word";
      message: string;
      charactersWritten: number;
    }
  | {
      operation: "excel-write";
      application: "excel";
      message: string;
      startCell: string;
      rowsWritten: number;
      columnsWritten: number;
      cellsWritten: number;
    }
  | {
      operation: "powerpoint-add-slide";
      application: "powerpoint";
      message: string;
      slideNumber?: number;
    };

export type OfficeAutomationErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PLATFORM"
  | "POWERSHELL_UNAVAILABLE"
  | "EXECUTION_TIMEOUT"
  | "OFFICE_NOT_INSTALLED"
  | "OFFICE_NOT_RUNNING"
  | "NO_ACTIVE_DOCUMENT"
  | "NO_ACTIVE_WORKBOOK"
  | "NO_ACTIVE_PRESENTATION"
  | "OFFICE_BUSY"
  | "INVALID_PAYLOAD"
  | "INVALID_RESPONSE"
  | "EXECUTION_FAILED";

export class OfficeAutomationError extends Error {
  readonly name = "OfficeAutomationError";

  constructor(
    readonly code: OfficeAutomationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface OfficeProcessInvocation {
  executable: string;
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}

export interface OfficeProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type OfficeCommandExecutor = (
  invocation: OfficeProcessInvocation,
) => Promise<OfficeProcessResult>;

export interface OfficeAutomationServiceOptions {
  platform?: NodeJS.Platform;
  executor?: OfficeCommandExecutor;
  timeoutMs?: number;
}

interface PreparedWordRequest extends WordAppendRequest {}

interface PreparedExcelRequest {
  operation: "excel-write";
  startCell: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

interface PreparedPowerPointRequest extends PowerPointAddSlideRequest {}

type PreparedOfficeRequest =
  | PreparedWordRequest
  | PreparedExcelRequest
  | PreparedPowerPointRequest;

interface OfficeScriptResponse {
  ok: boolean;
  code: string;
  message?: string;
  operation?: string;
  slideNumber?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_WORD_CHARACTERS = 20_000;
const MAX_EXCEL_ROWS = 200;
const MAX_EXCEL_COLUMNS = 50;
const MAX_EXCEL_CELLS = 2_000;
const MAX_EXCEL_CELL_CHARACTERS = 8_000;
const MAX_EXCEL_TOTAL_CHARACTERS = 40_000;
const MAX_POWERPOINT_TITLE_CHARACTERS = 300;
const MAX_POWERPOINT_BODY_CHARACTERS = 12_000;
const EXCEL_MAX_ROW = 1_048_576;
const EXCEL_MAX_COLUMN = 16_384;

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Send-OfficeResult {
  param(
    [bool]$Ok,
    [string]$Code,
    [string]$Message,
    [string]$Operation,
    [hashtable]$Data
  )
  $result = [ordered]@{ ok = $Ok; code = $Code; message = $Message }
  if (-not [string]::IsNullOrWhiteSpace($Operation)) { $result.operation = $Operation }
  if ($null -ne $Data) {
    foreach ($key in $Data.Keys) { $result[$key] = $Data[$key] }
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
}

function Stop-OfficeOperation {
  param([string]$Code, [string]$Message, [string]$Operation)
  Send-OfficeResult -Ok $false -Code $Code -Message $Message -Operation $Operation -Data $null
  exit 1
}

function Get-ActiveOfficeApplication {
  param([string]$ProgId, [string]$Operation)
  $officeType = [Type]::GetTypeFromProgID($ProgId)
  if ($null -eq $officeType) {
    Stop-OfficeOperation -Code 'OFFICE_NOT_INSTALLED' -Message 'Office application is not installed.' -Operation $Operation
  }
  try {
    return [Runtime.InteropServices.Marshal]::GetActiveObject($ProgId)
  } catch {
    Stop-OfficeOperation -Code 'OFFICE_NOT_RUNNING' -Message 'Office application is not running.' -Operation $Operation
  }
}

$operation = ''
try {
  $encodedPayload = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($encodedPayload)) {
    Stop-OfficeOperation -Code 'INVALID_PAYLOAD' -Message 'Office payload is empty.' -Operation $operation
  }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload.Trim()))
    $payload = $json | ConvertFrom-Json
    $operation = [string]$payload.operation
  } catch {
    Stop-OfficeOperation -Code 'INVALID_PAYLOAD' -Message 'Office payload is invalid.' -Operation $operation
  }

  switch ($operation) {
    'word-append' {
      $app = Get-ActiveOfficeApplication -ProgId 'Word.Application' -Operation $operation
      if ($app.Documents.Count -lt 1 -or $null -eq $app.ActiveDocument) {
        Stop-OfficeOperation -Code 'NO_ACTIVE_DOCUMENT' -Message 'Word has no active document.' -Operation $operation
      }
      $text = [string]$payload.text
      $range = $app.ActiveDocument.Content
      $range.Collapse(0)
      [void]$range.InsertAfter($text)
      Send-OfficeResult -Ok $true -Code 'OK' -Message 'Text appended to Word.' -Operation $operation -Data @{ characters = $text.Length }
      break
    }
    'excel-write' {
      $app = Get-ActiveOfficeApplication -ProgId 'Excel.Application' -Operation $operation
      if ($app.Workbooks.Count -lt 1 -or $null -eq $app.ActiveWorkbook -or $null -eq $app.ActiveSheet) {
        Stop-OfficeOperation -Code 'NO_ACTIVE_WORKBOOK' -Message 'Excel has no active workbook.' -Operation $operation
      }
      $rowCount = [int]$payload.rowCount
      $columnCount = [int]$payload.columnCount
      $values = @($payload.values)
      if ($rowCount -lt 1 -or $columnCount -lt 1 -or $values.Count -ne ($rowCount * $columnCount)) {
        Stop-OfficeOperation -Code 'INVALID_PAYLOAD' -Message 'Excel table dimensions are invalid.' -Operation $operation
      }
      $matrix = [Array]::CreateInstance([object], [int[]]@($rowCount, $columnCount), [int[]]@(1, 1))
      for ($row = 0; $row -lt $rowCount; $row++) {
        for ($column = 0; $column -lt $columnCount; $column++) {
          $index = ($row * $columnCount) + $column
          $matrix.SetValue([string]$values[$index], $row + 1, $column + 1)
        }
      }
      $sheet = $app.ActiveSheet
      $startRange = $sheet.Range([string]$payload.startCell)
      $endRange = $startRange.Offset($rowCount - 1, $columnCount - 1)
      $targetRange = $sheet.Range($startRange, $endRange)
      $previousEnableEvents = [bool]$app.EnableEvents
      $app.EnableEvents = $false
      try {
        $targetRange.NumberFormat = '@'
        $targetRange.Value2 = $matrix
      } finally {
        try { $app.EnableEvents = $previousEnableEvents } catch { }
      }
      Send-OfficeResult -Ok $true -Code 'OK' -Message 'Text table written to Excel.' -Operation $operation -Data @{ rows = $rowCount; columns = $columnCount }
      break
    }
    'powerpoint-add-slide' {
      $app = Get-ActiveOfficeApplication -ProgId 'PowerPoint.Application' -Operation $operation
      if ($app.Presentations.Count -lt 1 -or $null -eq $app.ActivePresentation) {
        Stop-OfficeOperation -Code 'NO_ACTIVE_PRESENTATION' -Message 'PowerPoint has no active presentation.' -Operation $operation
      }
      $presentation = $app.ActivePresentation
      $slideNumber = $presentation.Slides.Count + 1
      $slide = $presentation.Slides.Add($slideNumber, 2)
      $slide.Shapes.Title.TextFrame.TextRange.Text = [string]$payload.title
      $slide.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = [string]$payload.body
      Send-OfficeResult -Ok $true -Code 'OK' -Message 'Slide added to PowerPoint.' -Operation $operation -Data @{ slideNumber = $slideNumber }
      break
    }
    default {
      Stop-OfficeOperation -Code 'INVALID_PAYLOAD' -Message 'Office operation is unknown.' -Operation $operation
    }
  }
} catch {
  $hresult = $_.Exception.HResult
  if ($hresult -eq -2147418111 -or $hresult -eq -2147417846) {
    Stop-OfficeOperation -Code 'OFFICE_BUSY' -Message 'Office application is busy.' -Operation $operation
  }
  Stop-OfficeOperation -Code 'EXECUTION_FAILED' -Message 'Office COM operation failed.' -Operation $operation
}
`;

const ENCODED_POWERSHELL_SCRIPT = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
const FIXED_POWERSHELL_ARGS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  ENCODED_POWERSHELL_SCRIPT,
]);

export class OfficeAutomationService {
  private readonly platform: NodeJS.Platform;
  private readonly executor: OfficeCommandExecutor;
  private readonly timeoutMs: number;

  constructor(options: OfficeAutomationServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.executor = options.executor ?? executePowerShell;
    this.timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1_000, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    );
  }

  appendWordText(text: string): Promise<OfficeAutomationResult> {
    return this.execute({ operation: "word-append", text });
  }

  writeExcel(
    startCell: string,
    content: string | readonly (readonly string[])[],
  ): Promise<OfficeAutomationResult> {
    return this.execute({ operation: "excel-write", startCell, content });
  }

  addPowerPointSlide(title: string, body: string): Promise<OfficeAutomationResult> {
    return this.execute({ operation: "powerpoint-add-slide", title, body });
  }

  async execute(request: OfficeAutomationRequest): Promise<OfficeAutomationResult> {
    const prepared = prepareRequest(request);
    if (this.platform !== "win32") {
      throw new OfficeAutomationError(
        "UNSUPPORTED_PLATFORM",
        "Office 桌面交互当前仅支持 Windows。",
      );
    }

    const invocation = buildInvocation(prepared, this.timeoutMs);
    let processResult: OfficeProcessResult;
    try {
      processResult = await this.executor(invocation);
    } catch (error) {
      throw mapExecutorError(error);
    }

    const response = parseScriptResponse(processResult.stdout);
    if (!response) {
      const detail = compactDetail(processResult.stderr);
      throw new OfficeAutomationError(
        "INVALID_RESPONSE",
        detail
          ? `Office 操作没有返回有效结果：${detail}`
          : "Office 操作没有返回有效结果。",
      );
    }
    if (!response.ok || processResult.exitCode !== 0) {
      throw mapScriptError(response.code, prepared.operation);
    }
    if (response.code !== "OK" || response.operation !== prepared.operation) {
      throw new OfficeAutomationError(
        "INVALID_RESPONSE",
        "Office 返回了与请求不匹配的结果。",
      );
    }

    return buildSuccessResult(prepared, response);
  }
}

function prepareRequest(request: OfficeAutomationRequest): PreparedOfficeRequest {
  if (!request || typeof request !== "object" || typeof request.operation !== "string") {
    throw invalidRequest("Office 操作参数格式无效。");
  }
  switch (request.operation) {
    case "word-append":
      return {
        operation: request.operation,
        text: sanitizeText(request.text, "Word 追加文本", MAX_WORD_CHARACTERS),
      };
    case "excel-write": {
      const start = parseCellReference(request.startCell);
      const rows = sanitizeExcelContent(request.content);
      const rowCount = rows.length;
      const columnCount = rows[0]!.length;
      if (start.row + rowCount - 1 > EXCEL_MAX_ROW
        || start.column + columnCount - 1 > EXCEL_MAX_COLUMN) {
        throw invalidRequest("Excel 写入区域超出了工作表边界。");
      }
      return {
        operation: request.operation,
        startCell: start.reference,
        rows,
        rowCount,
        columnCount,
      };
    }
    case "powerpoint-add-slide":
      return {
        operation: request.operation,
        title: sanitizeText(request.title, "PowerPoint 标题", MAX_POWERPOINT_TITLE_CHARACTERS),
        body: sanitizeText(request.body, "PowerPoint 正文", MAX_POWERPOINT_BODY_CHARACTERS),
      };
    default:
      throw invalidRequest("Office 操作类型不在允许范围内。");
  }
}

function sanitizeText(value: unknown, label: string, maxCharacters: number): string {
  if (typeof value !== "string") throw invalidRequest(`${label}必须是文本。`);
  if (!value.trim()) throw invalidRequest(`${label}为空。`);
  if (value.includes("\0")) throw invalidRequest(`${label}包含无效字符。`);
  if (value.length > maxCharacters) {
    throw invalidRequest(`${label}超过 ${maxCharacters} 个字符。`);
  }
  return value;
}

function sanitizeExcelContent(value: ExcelWriteRequest["content"]): string[][] {
  let sourceRows: readonly (readonly unknown[])[];
  if (typeof value === "string") {
    if (!value.trim()) throw invalidRequest("Excel 写入内容为空。");
    const normalized = value.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    while (lines.length > 1 && lines.at(-1) === "") lines.pop();
    sourceRows = lines.map((line) => line.split("\t"));
  } else if (Array.isArray(value)) {
    sourceRows = value;
  } else {
    throw invalidRequest("Excel 写入内容必须是 TSV 文本或二维文本数组。");
  }

  if (sourceRows.length < 1 || sourceRows.length > MAX_EXCEL_ROWS) {
    throw invalidRequest(`Excel 单次写入行数需在 1～${MAX_EXCEL_ROWS} 之间。`);
  }
  let columnCount = 0;
  let totalCharacters = 0;
  const rows = sourceRows.map((sourceRow) => {
    if (!Array.isArray(sourceRow) || sourceRow.length < 1) {
      throw invalidRequest("Excel 二维数组中的每一行至少需要一个单元格。");
    }
    if (sourceRow.length > MAX_EXCEL_COLUMNS) {
      throw invalidRequest(`Excel 单次写入列数最多为 ${MAX_EXCEL_COLUMNS}。`);
    }
    columnCount = Math.max(columnCount, sourceRow.length);
    return sourceRow.map((cell) => {
      if (typeof cell !== "string") throw invalidRequest("Excel 单元格内容必须是文本。");
      if (cell.includes("\0")) throw invalidRequest("Excel 单元格包含无效字符。");
      if (cell.length > MAX_EXCEL_CELL_CHARACTERS) {
        throw invalidRequest(`Excel 单元格内容最多为 ${MAX_EXCEL_CELL_CHARACTERS} 个字符。`);
      }
      totalCharacters += cell.length;
      return cell;
    });
  });
  if (rows.length * columnCount > MAX_EXCEL_CELLS) {
    throw invalidRequest(`Excel 单次写入最多为 ${MAX_EXCEL_CELLS} 个单元格。`);
  }
  if (totalCharacters > MAX_EXCEL_TOTAL_CHARACTERS) {
    throw invalidRequest(`Excel 单次写入内容最多为 ${MAX_EXCEL_TOTAL_CHARACTERS} 个字符。`);
  }
  for (const row of rows) {
    while (row.length < columnCount) row.push("");
  }
  return rows;
}

function parseCellReference(value: unknown): { reference: string; row: number; column: number } {
  if (typeof value !== "string") throw invalidRequest("Excel 起始单元格必须使用 A1 格式。");
  const reference = value.trim().toUpperCase();
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(reference);
  if (!match) throw invalidRequest("Excel 起始单元格必须使用 A1 格式。");
  const letters = match[1]!;
  const row = Number(match[2]);
  let column = 0;
  for (const character of letters) {
    column = (column * 26) + character.charCodeAt(0) - 64;
  }
  if (row > EXCEL_MAX_ROW || column > EXCEL_MAX_COLUMN) {
    throw invalidRequest("Excel 起始单元格超出了工作表边界。");
  }
  return { reference, row, column };
}

function buildInvocation(request: PreparedOfficeRequest, timeoutMs: number): OfficeProcessInvocation {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const payload = request.operation === "excel-write"
    ? {
        operation: request.operation,
        startCell: request.startCell,
        rowCount: request.rowCount,
        columnCount: request.columnCount,
        values: request.rows.flat(),
      }
    : request;
  return {
    executable: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: FIXED_POWERSHELL_ARGS,
    stdin: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    timeoutMs,
  };
}

function executePowerShell(invocation: OfficeProcessInvocation): Promise<OfficeProcessResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      invocation.executable,
      [...invocation.args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: invocation.timeoutMs,
        maxBuffer: 512 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
    child.stdin?.end(invocation.stdin, "utf8");
  });
}

function parseScriptResponse(stdout: string): OfficeScriptResponse | undefined {
  const lines = stdout.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index]!) as Partial<OfficeScriptResponse>;
      if (typeof value.ok !== "boolean" || typeof value.code !== "string") continue;
      return {
        ok: value.ok,
        code: value.code,
        message: typeof value.message === "string" ? value.message : undefined,
        operation: typeof value.operation === "string" ? value.operation : undefined,
        slideNumber: typeof value.slideNumber === "number" ? value.slideNumber : undefined,
      };
    } catch {
      // PowerShell can emit host warnings before the final structured line.
    }
  }
  return undefined;
}

function mapExecutorError(error: unknown): OfficeAutomationError {
  const details = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (details.code === "ENOENT") {
    return new OfficeAutomationError(
      "POWERSHELL_UNAVAILABLE",
      "系统 PowerShell 组件不可用，Office 操作没有启动。",
      { cause: error },
    );
  }
  if (details.code === "ETIMEDOUT" || details.killed === true || details.signal === "SIGTERM"
    || (typeof details.message === "string" && /timed?\s*out|timeout/i.test(details.message))) {
    return new OfficeAutomationError(
      "EXECUTION_TIMEOUT",
      "Office 响应超时，操作结果尚未确认，请检查当前文档后再重试。",
      { cause: error },
    );
  }
  return new OfficeAutomationError(
    "EXECUTION_FAILED",
    "Office 操作进程启动失败。",
    { cause: error },
  );
}

function mapScriptError(code: string, operation: OfficeAutomationOperation): OfficeAutomationError {
  const application = applicationLabel(operation);
  switch (code) {
    case "OFFICE_NOT_INSTALLED":
      return new OfficeAutomationError(
        code,
        `未检测到 Microsoft ${application} 桌面版，请先安装 Office 后重试。`,
      );
    case "OFFICE_NOT_RUNNING":
      return new OfficeAutomationError(
        code,
        `Microsoft ${application} 尚未运行，请先打开应用和目标文件。`,
      );
    case "NO_ACTIVE_DOCUMENT":
      return new OfficeAutomationError(code, "Word 当前没有打开的文档，请先打开目标文档。");
    case "NO_ACTIVE_WORKBOOK":
      return new OfficeAutomationError(code, "Excel 当前没有打开的工作簿，请先打开目标工作簿。");
    case "NO_ACTIVE_PRESENTATION":
      return new OfficeAutomationError(code, "PowerPoint 当前没有打开的演示文稿，请先打开目标演示文稿。");
    case "OFFICE_BUSY":
      return new OfficeAutomationError(code, `Microsoft ${application} 当前正忙，请稍后重试。`);
    case "INVALID_PAYLOAD":
      return new OfficeAutomationError(code, "Office 操作参数在执行前校验失败。");
    default:
      return new OfficeAutomationError(
        "EXECUTION_FAILED",
        `Microsoft ${application} 没有完成写入，请确认目标文件可编辑后重试。`,
      );
  }
}

function buildSuccessResult(
  request: PreparedOfficeRequest,
  response: OfficeScriptResponse,
): OfficeAutomationResult {
  switch (request.operation) {
    case "word-append":
      return {
        operation: request.operation,
        application: "word",
        message: "已向当前 Word 文档追加文本。",
        charactersWritten: request.text.length,
      };
    case "excel-write":
      return {
        operation: request.operation,
        application: "excel",
        message: `已从 ${request.startCell} 开始写入 ${request.rowCount}×${request.columnCount} 的纯文本表格。`,
        startCell: request.startCell,
        rowsWritten: request.rowCount,
        columnsWritten: request.columnCount,
        cellsWritten: request.rowCount * request.columnCount,
      };
    case "powerpoint-add-slide": {
      const slideNumber = Number.isInteger(response.slideNumber) && response.slideNumber! > 0
        ? response.slideNumber
        : undefined;
      return {
        operation: request.operation,
        application: "powerpoint",
        message: slideNumber
          ? `已在当前 PowerPoint 中添加第 ${slideNumber} 页。`
          : "已在当前 PowerPoint 中添加一页。",
        slideNumber,
      };
    }
  }
}

function applicationLabel(operation: OfficeAutomationOperation): "Word" | "Excel" | "PowerPoint" {
  if (operation === "word-append") return "Word";
  if (operation === "excel-write") return "Excel";
  return "PowerPoint";
}

function compactDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

function invalidRequest(message: string): OfficeAutomationError {
  return new OfficeAutomationError("INVALID_REQUEST", message);
}
