import { useEffect, useState } from 'react';
import { supabase } from '../utils/supabase/client';

/**
 * Example component demonstrating how to query Supabase from React (Vite).
 * Equivalent to the Next.js `page.tsx` example adapted for client-side React.
 */
export default function SupabaseTodoList() {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;

    async function fetchTodos() {
      try {
        setLoading(true);
        const { data, error: err } = await supabase.from('todos').select();
        if (err) throw err;
        if (isMounted) setTodos(data || []);
      } catch (err) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchTodos();

    return () => {
      isMounted = false;
    };
  }, []);

  if (loading) return <div className="p-4 text-sm text-gray-500">Loading todos...</div>;
  if (error) return <div className="p-4 text-sm text-red-500">Error loading todos: {error}</div>;

  return (
    <ul className="space-y-1 p-4">
      {todos.map((todo) => (
        <li key={todo.id} className="text-sm">
          {todo.name}
        </li>
      ))}
    </ul>
  );
}
