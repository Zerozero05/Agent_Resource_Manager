import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Loaded only when a document is displayed. Callers keep their existing renderers and state.
export default function MarkdownRenderer(props: Omit<Options, 'remarkPlugins' | 'urlTransform'>) {
  return <ReactMarkdown {...props} remarkPlugins={[remarkGfm]} urlTransform={defaultUrlTransform} />;
}
