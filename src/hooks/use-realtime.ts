"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { realtimeTopic } from "@/lib/realtime/channel";
import type { Message, Conversation } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  /**
   * Base topic name. Scoped to `accountId` before use — see
   * `realtimeTopic`. Never reaches the wire on its own.
   */
  channelName: string;
  /**
   * The caller's ACTIVE zone, from `useAuth()`. Required, and required
   * to be live rather than captured once: both `.on()` subscriptions
   * below are unfiltered, so RLS alone decides which rows arrive, and
   * RLS answers for whichever zone is active at the time. When the user
   * switches zone the database simply stops serving the old rows — but
   * the channel, and every piece of state the caller built from it,
   * would otherwise carry on as if nothing had happened. Keying the
   * topic on the account is what makes the effect below tear the old
   * subscription down and build a new one.
   *
   * `null` while the profile is still resolving; the hook stays idle.
   */
  accountId: string | null | undefined;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  accountId,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  const topic = realtimeTopic(channelName, accountId);

  useEffect(() => {
    if (!enabled || !topic) return;

    const supabase = createClient();

    const channel = supabase
      .channel(topic)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Message>["eventType"],
            new: payload.new as Message,
            old: payload.old as Partial<Message>,
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          onConversationRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Conversation>["eventType"],
            new: payload.new as Conversation,
            old: payload.old as Partial<Conversation>,
          });
        }
      )
      .subscribe((status) => {
        setIsConnected(status === "SUBSCRIBED");
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
    // `topic` carries the account, so a zone switch changes it and the
    // cleanup above runs before the new subscription is built.
  }, [topic, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
