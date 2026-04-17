#!/usr/sbin/dtrace -Cs
/*
 * nanoclaw-proc.d — Process activity tracing per jail
 *
 * Traces fork, exec, and exit events for a specific jail.
 * Uses the proc provider for process lifecycle events with jail ID filtering
 * via curthread->td_ucred->cr_prison->pr_id.
 *
 * Usage:
 *   sudo dtrace -C -s etc/dtrace/nanoclaw-proc.d -D jailid=<JID>
 *
 * Example:
 *   sudo dtrace -C -s etc/dtrace/nanoclaw-proc.d -D jailid=5
 *
 * Output columns (tab-separated):
 *   TIMESTAMP  EVENT  PID  PROCESS  DETAIL
 */

#pragma D option quiet

/* Header */
dtrace:::BEGIN
{
	printf("TIMESTAMP\tEVENT\tPID\tPROCESS\tDETAIL\n");
}

/* Trace fork — new child process */
proc:::create
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	printf("%Y\tfork\t%d\t%s\tchild_pid=%d\n",
	    walltimestamp, pid, execname, args[0]->p_pid);
}

/* Trace exec — process replaces its image */
proc:::exec-success
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	printf("%Y\texec\t%d\t%s\t%s\n",
	    walltimestamp, pid, execname, curpsinfo->pr_psargs);
}

/* Trace exit — process terminates */
proc:::exit
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	printf("%Y\texit\t%d\t%s\texit_status=%d\n",
	    walltimestamp, pid, execname, args[0]);
}
