const officeWorkflows = [
  {
    id: 'office-documents', name: 'Documents', description: '创建、编辑和检查 Word 文档', color: '#2563eb',
    library: 'python-docx', module: 'docx',
    guidance: 'Inspect paragraph styles, sections, headers, and tables before editing. Use python-docx to create or update .docx files. Preserve unrelated content and save a separate output unless the user asks to overwrite. Reopen the output and check the expected headings, paragraphs, and table cells. Use an available renderer for layout checks when required.',
  },
  {
    id: 'office-pdf', name: 'PDF', description: '读取、创建和验证 PDF', color: '#dc473f',
    library: 'pypdf / reportlab', module: 'pypdf or reportlab (as needed)',
    guidance: 'Use pypdf to inspect, extract, merge, or split existing pages, and reportlab to create new PDFs. Preserve source files. Reopen each output and verify page count and expected text. For scans, use trusted OCR only if available. Use an available renderer for visual checks when the requested outcome depends on layout.',
  },
  {
    id: 'office-spreadsheets', name: 'Spreadsheets', description: '创建、编辑和检查 Excel 工作簿', color: '#17854d',
    library: 'openpyxl', module: 'openpyxl',
    guidance: 'Use openpyxl to work with .xlsx files. Inspect worksheet names, formulas, number formats, and protected ranges before editing. Preserve other sheets and style definitions. Reopen the saved workbook to verify values and formulas. If a spreadsheet engine is available, use it to verify calculated results because openpyxl does not recalculate formulas.',
  },
  {
    id: 'office-presentations', name: 'Presentations', description: '创建、编辑和检查 PowerPoint 幻灯片', color: '#c57915',
    library: 'python-pptx', module: 'pptx',
    guidance: 'Use python-pptx to create or edit .pptx files. Inspect the slide size, layouts, and masters before changing content. Save a separate deliverable unless the user asks to overwrite. Reopen the deck and check slide count, titles, and speaker notes where required. Use an available renderer to check for clipping and overlaps.',
  },
];

export const officePlugins = officeWorkflows.map(({ id, name, description, color, library }) => ({
  id, slug: id, name, description, brandColor: color, tileFg: color, tileBg: `${color}20`,
  category: 'Productivity', author: 'Agent_US', transport: 'Built-in · Skills', endpoint: '',
  longDescription: `${description}。运行时使用工作区的 Python 和 ${library}，执行前检查依赖。`,
  tools: [], bundledSkills: [name],
}));

export function officeSkill(id) {
  const definition = officeWorkflows.find((item) => item.id === id);
  if (!definition) return null;
  return `---
name: ${definition.name}
description: ${definition.description}
---

${definition.guidance}

Check Python and ${definition.module} using the standard workspace tool runtime. If the required dependency is unavailable, tell the user which package is missing and request approval before installation. Follow workspace boundaries and approval policy. Report actual verification performed and return the output path.
`;
}
