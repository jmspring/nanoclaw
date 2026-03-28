#!/usr/sbin/dtrace -Cs
/*
 * nanoclaw-net.d — Network activity tracing per jail
 *
 * Traces connect(), sendto(), and recvfrom() syscalls for a specific jail.
 * Uses curthread->td_ucred->cr_prison->pr_id for jail ID filtering.
 *
 * Limitation: Extracting IP addresses from sockaddr structs in D is non-trivial.
 * This script traces at the syscall level with FD and byte counts. For full
 * address decoding, use tcpdump on the jail's epair interface instead.
 *
 * Usage:
 *   sudo dtrace -C -s etc/dtrace/nanoclaw-net.d -D jailid=<JID>
 *
 * Example:
 *   sudo dtrace -C -s etc/dtrace/nanoclaw-net.d -D jailid=5
 *
 * Output columns (tab-separated):
 *   TIMESTAMP  SYSCALL  PID  PROCESS  FD  BYTES  RETVAL
 */

#pragma D option quiet

/* Header */
dtrace:::BEGIN
{
	printf("TIMESTAMP\tSYSCALL\tPID\tPROCESS\tFD\tBYTES\tRETVAL\n");
}

/* Trace connect() */
syscall::connect:entry
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	self->connectfd = arg0;
}

syscall::connect:return
/self->connectfd != 0/
{
	printf("%Y\tconnect\t%d\t%s\tfd=%d\t-\t%d\n",
	    walltimestamp, pid, execname, self->connectfd, arg1);
	self->connectfd = 0;
}

/* Trace sendto() — capture byte count */
syscall::sendto:entry
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	self->sendfd = arg0;
	self->sendbytes = arg2;
}

syscall::sendto:return
/self->sendfd != 0/
{
	printf("%Y\tsendto\t%d\t%s\tfd=%d\t%d\t%d\n",
	    walltimestamp, pid, execname, self->sendfd, self->sendbytes, arg1);
	self->sendfd = 0;
	self->sendbytes = 0;
}

/* Trace recvfrom() — capture byte count */
syscall::recvfrom:entry
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	self->recvfd = arg0;
}

syscall::recvfrom:return
/self->recvfd != 0/
{
	printf("%Y\trecvfrom\t%d\t%s\tfd=%d\t%d\t%d\n",
	    walltimestamp, pid, execname, self->recvfd, arg1, arg1);
	self->recvfd = 0;
}
