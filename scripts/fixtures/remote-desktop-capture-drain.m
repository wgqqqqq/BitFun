// Exercise the production drain with inert sources. No capture, permissions or input.
#include "../../src/apps/desktop/src/remote_desktop/macos_display_capture.m"

@interface DrainStream : NSObject
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) dispatch_semaphore_t blocked;
@property(nonatomic, strong) dispatch_semaphore_t unblock;
@end
@implementation DrainStream
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))completion {
    dispatch_async(self.queue, ^{
        dispatch_semaphore_signal(self.blocked);
        dispatch_semaphore_wait(self.unblock, DISPATCH_TIME_FOREVER);
    });
    dispatch_semaphore_wait(self.blocked, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
    completion(nil);
}
@end

static BOOL blocked_drain(BOOL finalBarrier) {
    OBFDisplaySource *source = [OBFDisplaySource new];
    atomic_init(&source->closing, false);
    source.queue = dispatch_queue_create("openbitfun.test.capture-drain", DISPATCH_QUEUE_SERIAL);
    source.condition = [NSCondition new];
    source.preparationFinished = YES;
    source.context = (void *)0x11; // Opaque witness; never dereferenced.
    dispatch_semaphore_t blocked = dispatch_semaphore_create(0);
    dispatch_semaphore_t release = dispatch_semaphore_create(0);
    if (finalBarrier) {
        DrainStream *stream = [DrainStream new];
        stream.queue = source.queue; stream.blocked = blocked; stream.unblock = release;
        source.stream = (SCStream *)stream;
        source.captureStarted = YES;
    } else {
        dispatch_async(source.queue, ^{
            dispatch_semaphore_signal(blocked);
            dispatch_semaphore_wait(release, DISPATCH_TIME_FOREVER);
        });
        dispatch_semaphore_wait(blocked, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
    }
    void *handle = (__bridge_retained void *)source;
    dispatch_semaphore_t returned = dispatch_semaphore_create(0);
    __block BOOL first = YES;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            first = obf_rd_display_destroy(handle);
            dispatch_semaphore_signal(returned);
        }
    });
    BOOL bounded = dispatch_semaphore_wait(returned,
        dispatch_time(DISPATCH_TIME_NOW, 9 * NSEC_PER_SEC)) == 0;
    BOOL retained = bounded && !first && atomic_load(&source->closing)
        && (finalBarrier ? source.context == NULL && source.stream != nil : source.context != NULL);
    // Always unblock our own queue, including for the pre-fix failure.
    dispatch_semaphore_signal(release);
    if (!bounded) {
        if (dispatch_semaphore_wait(returned, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) != 0) return NO;
    }
    dispatch_semaphore_t drained = dispatch_semaphore_create(0);
    dispatch_async(source.queue, ^{ dispatch_semaphore_signal(drained); });
    if (dispatch_semaphore_wait(drained, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) != 0) return NO;
    __block BOOL retry = NO;
    if (!first) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            @autoreleasepool {
                retry = obf_rd_display_destroy(handle);
                dispatch_semaphore_signal(returned);
            }
        });
        if (dispatch_semaphore_wait(returned, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) != 0) return NO;
    }
    BOOL passed = bounded && retained && retry && source.context == NULL && source.stream == nil;
    printf("{\"barrier\":\"%s\",\"bounded\":%s,\"handle_retained\":%s,\"retry_drained\":%s,\"passed\":%s}\n",
        finalBarrier ? "final_clear" : "context_detach", bounded ? "true" : "false",
        retained ? "true" : "false", retry ? "true" : "false", passed ? "true" : "false");
    fflush(stdout);
    return passed;
}

int main(void) {
    @autoreleasepool {
        BOOL detach = blocked_drain(NO);
        BOOL final = blocked_drain(YES);
        return detach && final ? 0 : 1;
    }
}
