import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the call-log routes.
// Mirrors src/lib/issues/admin-client.ts — reads go through the
// caller's cookie client so RLS scopes them, and only writes come
// through here, where RLS is bypassed and the route must therefore
// enforce the role and resolve account_id itself.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
