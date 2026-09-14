import type { RenderRequest } from './workerRenderer';

type Translate = (key: string) => string;
type Render = (request: RenderRequest) => Promise<string>;

export function createLocalizedRenderRequest(translate: Translate, render: Render): Render {
  return (request) =>
    render({
      copyButtonLabel: translate('render.copyCode'),
      copiedLabel: translate('render.copied'),
      copyCodeAriaLabel: translate('render.copyCodeAria'),
      copyMarkdownAriaLabel: translate('render.copyMarkdownAria'),
      ...request,
    });
}
