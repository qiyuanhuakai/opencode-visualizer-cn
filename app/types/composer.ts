export type LineCommentData = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type ComposerAttachment = {
  id: string;
  filename: string;
  mime: string;
  dataUrl: string;
  lineComment?: LineCommentData;
};
