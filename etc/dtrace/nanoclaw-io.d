#!/usr/sbin/dtrace -Cs
/*
 * nanoclaw-io.d — File I/O tracing per jail
 *
 * Traces open(), read(), write(), and unlink() syscalls for a specific jail.
 * Uses curthread->td_ucred->cr_prison->pr_id for jail ID filtering
 * (FreeBSD 15 compatible).
 *
 * Usage:
 *   sudo dtrace -C -s etc/dtrace/nanoclaw-io.d -D jailid=<JID>
 *
 * Example:
 *   sudo dtrace -C -s etc/dtrace/nanoclaw-io.d -D jailid=5
 *
 * Output columns (tab-separated):
 *   TIMESTAMP  SYSCALL  PID  PROCESS  PATH/BYTES  RETVAL
 */

#pragma D option quiet

/* Header */
dtrace:::BEGIN
{
	printf("TIMESTAMP\tSYSCALL\tPID\tPROCESS\tARG\tRETVAL\n");
}

/* Trace open() — capture file path */
syscall::openat:entry
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	self->path = copyinstr(arg1);
}

syscall::openat:return
/self->path != NULL/
{
	printf("%Y\topen\t%d\t%s\t%s\t%d\n",
	    walltimestamp, pid, execname, self->path, arg1);
	self->path = NULL;
}

/* Trace read() — capture byte count */
syscall::read:entry
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	self->reading = 1;
}

syscall::read:return
/self->reading/
{
	printf("%Y\tread\t%d\t%s\t%d bytes\t%d\n",
	    walltimestamp, pid, execname, arg1, arg1);
	self->reading = 0;
}

/* Trace write() — capture byte count */
syscall::write:entry
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	self->writing = 1;
}

syscall::write:return
/self->writing/
{
	printf("%Y\twrite\t%d\t%s\t%d bytes\t%d\n",
	    walltimestamp, pid, execname, arg1, arg1);
	self->writing = 0;
}

/* Trace unlink() — capture file path */
syscall::unlinkat:entry
/curthread->td_ucred->cr_prison->pr_id == jailid/
{
	self->unlinkpath = copyinstr(arg1);
}

syscall::unlinkat:return
/self->unlinkpath != NULL/
{
	printf("%Y\tunlink\t%d\t%s\t%s\t%d\n",
	    walltimestamp, pid, execname, self->unlinkpath, arg1);
	self->unlinkpath = NULL;
}
