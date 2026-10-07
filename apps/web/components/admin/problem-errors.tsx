import type { ApiError } from '@/lib/api';

/** A failed admin action: the message, then each itemised `{path, message}` the API sent. */
export function ActionError({ error }: { error: ApiError | Error }) {
  const items = 'errors' in error ? error.errors : undefined;
  return (
    <div role="alert" className="flex flex-col gap-1 text-13 text-danger">
      <p>{error.message}</p>
      {items && items.length > 0 ? (
        <ul className="list-disc pl-5">
          {items.map((e) => (
            <li key={`${e.path}:${e.message}`}>
              <span className="font-mono">{e.path}</span>: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
