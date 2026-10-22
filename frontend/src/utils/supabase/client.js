import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL;

const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    'Supabase URL or Anon/Publishable Key is missing. Please check your frontend/.env file.'
  );
}

/**
 * Creates a new Supabase client instance.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export const createClient = () => createSupabaseClient(supabaseUrl, supabaseKey);

/**
 * Singleton Supabase client instance for standard use across the app.
 */
export const supabase = createSupabaseClient(supabaseUrl, supabaseKey);

export default supabase;
