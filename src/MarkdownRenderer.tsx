import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Reuse the rendered document while its content and custom renderers stay the same.
export default memo(function MarkdownRenderer(props: Omit<Options, 'remarkPlugins' | 'urlTransform'>) {
  return <ReactMarkdown {...props} remarkPlugins={[remarkGfm]} urlTransform={defaultUrlTransform} />;
});
