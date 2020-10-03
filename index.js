const S3Buffer=require('s3buffer');
const fs = require('fs');
const crypto=require('crypto');
const makeYellow="\x1b[33m";
const makeNormal="\x1b[0m";
const deltreeFs = require("deltree");
const sleep=require('sleep-promise');

async function checkFileExists(file) {
    return fs.promises.access(file, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false)
}

class Cache {
    /**
     * Defaults:
     *      fileLimit(max file size in bytes to store in RAM):  100KB
     *      totalLimit(max amount of RAM to use in bytes):      500MB
     *      longterm:                                           off
     *          should be a string path to a folder to use or s3 access key info and bucket name
     *      pathLimit(max number of path entries to keep in RAM):100k
     *      debug:                                              flase
     *          if true will write to console every time data is removed or replaced from RAM
     *      clearCheckInterval:                                 undefined
     *          number of ms between checking if clear file exists.
     *          only applicable if longterm is defined
     * @param {{
     *     fileLimit:   int,
     *     totalLimit:  int,
     *     longterm:    string|{accessKeyId: string,secretAccessKey: string,bucket: string},
     *     pathLimit:   int,
     *     debug:       boolean,
     *     clearCheckInterval: int
     * }}options
     */
    constructor(options) {
        //configure options
        let {fileLimit,totalLimit,longterm,pathLimit,debug,clearCheckInterval}=options;
        this._fileLimit=fileLimit||100000;
        this._totalLimit=totalLimit||500000000;
        this._longterm=longterm||false;
        this._pathLimit=pathLimit||100000;
        this._debug=debug||false;

        //set startup values
        this._pathIndex=0;
        this._current=0;
        this._caches={};    //[time,data]
        this._paths={};     //[index,name]
        this._scoreFunc=(age,size)=>{
            //largest values get removed first
            return age*Math.ceil(size/10000);   //for every 10k age the file faster
        }

        //handle long term
        if (this._longterm!==false) {
            if (typeof this._longterm==="string") {



                //file system
                //if long term is a string then it is a path to a folder we can use
                //noinspection JSCheckFunctionSignatures
                const masterPath=fs.realpathSync(longterm);

                //make sure folder exists and sub folders
                if (!fs.existsSync(masterPath)) throw new Error(`long-term folder does not exist: ${masterPath}`);
                if (!fs.existsSync(masterPath+"/caches")) fs.mkdirSync(masterPath+"/caches");
                if (!fs.existsSync(masterPath+"/paths")) fs.mkdirSync(masterPath+"/paths");

                /**
                 *
                 * @type {
                 *   {
                 *      readCache: (function(hash: string): Promise<Buffer>),
                 *      writeCache: (function(hash: string, cacheData: Buffer): Promise<void>),
                 *      readPath: (function(path: string): Promise<string>),
                 *      writePath: (function(path: string, cacheHash: string): Promise<void>),
                 *      clear: (function(check: boolean): Promise<boolean>)
                 *   } |boolean
                 * }
                 * @private
                 */
                this._longterm={
                    readPath:   async (path)=>{
                        return (await fs.promises.readFile(masterPath+"/paths/"+path)).toString('hex');
                    },
                    readCache:  async (hash)=>{
                        return fs.promises.readFile(masterPath+"/caches/"+hash);
                    },
                    writePath:  async (path,cacheHash)=>{
                        const hash=Buffer.from(cacheHash,'hex');
                        await fs.promises.writeFile(masterPath+"/paths/"+path,hash);
                    },
                    writeCache: async (hash,cacheData)=>{
                        await fs.promises.writeFile(masterPath+"/caches/"+hash,cacheData);
                    },
                    clear: async (check=false)=>{
                        if (check&&!(await checkFileExists(masterPath+'/clear'))) return false; //clear missing and needed so bail
                        deltreeFs(masterPath);
                        fs.mkdirSync(masterPath);
                        fs.mkdirSync(masterPath+"/caches");
                        fs.mkdirSync(masterPath+"/paths");
                        this._pathIndex=0;
                        this._current=0;
                        this._caches={};    //[time,data]
                        this._paths={};     //[index,name]
                        return true;
                    }
                }





            } else {



                //aws s3 bucket
                //should be in form {accessKeyId: string,secretAccessKey: string,bucket: string}

                const s3buffer=new S3Buffer(this._longterm);
                this._longterm={
                    readPath:   async (path)=>(await s3buffer.read("paths/"+path)).toString('hex'),
                    readCache:  async (hash)=>s3buffer.read("caches/"+hash),
                    writePath:  async (path,cacheHash)=>s3buffer.write("paths/"+path,Buffer.from(cacheHash,'hex')),
                    writeCache: async (hash,cacheData)=>s3buffer.write("caches/"+hash,cacheData),
                    clear: async (check=false)=>{
                        if (check&&!(await s3buffer.exists("clear"))) return false; //clear missing and needed so bail
                        await s3buffer.clear();
                        this._pathIndex=0;
                        this._current=0;
                        this._caches={};    //[time,data]
                        this._paths={};     //[index,name]
                        return true;
                    }
                }



            }

        }

        //clear checking
        if (clearCheckInterval!==undefined) {
            (async()=> {
                // noinspection InfiniteLoopJS
                while (true) {
                    await this._longterm.clear(true);
                    await sleep(clearCheckInterval);
                }
            })();
        }
    }

    /**
     * Gets the current amount of RAM being used by the cache in bytes
     * @return {int}
     */
    get size() {
        return this._current;
    }

    /**
     * Allows a custom scoring formula for what to keep in ram if it gets full.  largest number gets removed first.
     * Function should return a number value
     * age is in milliseconds
     * size is in bytes
     * @param {(function(age,size): Number)} func
     */
    set scoreFunc(func) {
        this._scoreFunc=func;
    }

    /**
     * Set the max file size that will be stored in RAM
     * If file is larger then this limit it will be stored in longterm storage if set
     * Please note by design it will not remove any existing files from RAM allowing you to set temporary exceptions by changing this value
     * @param {int} bytes
     */
    set fileLimit(bytes) {
        this._fileLimit=bytes;
    }

    /**
     * Gets the max file size to be stored in RAM in bytes
     * @return {int}
     */
    get fileLimit() {
        return this._fileLimit;
    }

    /**
     * Sets the max amount of RAM to use for storage.  Actual ram usage will be slightly higher do to javascript overhead
     * Will remove files if over new limit
     * @param {int} bytes
     */
    set totalLimit(bytes) {
        this._totalLimit=bytes;
        this._freeSpaceInRAM(0);
    }

    /**
     * Gets the max amount of RAM to use for storage
     * @return {int}
     */
    get totalLimit() {
        return this._totalLimit;
    }

    /**
     * Stores the path in RAM
     * @param {string}  path
     * @param {string}  hash
     * @private
     */
    _storePathInRAM(path,hash) {
        //update path if already there
        if (this._paths[path]!==undefined) {
            if (this._debug) console.log(`path updated: ${makeYellow}${path}${makeNormal}  from: ${makeYellow}${this._paths[path][1]}${makeNormal}  to: ${makeYellow}${hash}${makeNormal}`);//if debug add console notice of change
            this._paths[path][1] = hash;                                                                //update the path
            return;                                                                                     //we did not increase size so no more processing needed
        }

        //add path
        if (this._debug) console.log(`path added: ${makeYellow}${path}${makeNormal}  to: ${makeYellow}${hash}${makeNormal}`);//if debug add console note of path adding
        this._paths[path] = [this._pathIndex++, hash];                                                  //store path and its index

        //remove earliest path if over limit
        if (this._pathIndex > this._pathLimit) {                                                        //check if we have exceeded the path cache size
            let removeIndex = this._pathIndex - this._pathLimit - 1;                                    //calculate the index we want to remove(lowest index)
            for (let pathIndex in this._paths) {                                                        //go through all paths
                if (this._paths[pathIndex][0] === removeIndex) {                                        //check if its the path we want to remove
                    if (this._debug) console.log(`path removed: ${makeYellow}${pathIndex}${makeNormal}`);//if debug add console notice of removal
                    delete this._paths[pathIndex];                                                      //remove path
                    return;                                                                             //skip checking all other baths
                }
            }
        }
    }

    /**
     * Make sure there is at least size bytes free in ram cache
     * @param {int} size
     * @param {int|boolean} now
     * @private
     */
    _freeSpaceInRAM(size=0,now=false) {
        if (this._current + size > this._totalLimit) {
            now=now||(new Date()).getTime();                                                            //make sure now is initialised
            let sorted = [];                                                                            //each entry in array is [score,hash]
            for (let hash in this._caches)
                sorted.push([this._scoreFunc(now - this._caches[hash][0], this._caches[hash][1].length), hash]);    //create array to be sorted
            sorted.sort((a, b) => a[0] - b[0]);                                                         //place highest scores at end of array
            while (this._current + size > this._totalLimit) {                                           //while we need to free space
                // noinspection JSUnusedLocalSymbols
                let [score, hash] = sorted.pop();                                                       //remove highest scored item
                let removalSize=this._caches[hash][1].length;                                           //get size of cache being removes
                this._current -= removalSize;                                                           //remove size from current value
                if (this._debug) console.log(`cache removed: ${makeYellow}${hash}${makeNormal}  freed: ${makeYellow}${removalSize}${makeNormal} bytes`);          //if debug add console notice of removal
                delete this._caches[hash];                                                              //remove file from ram
            }
        }
    }

    /**
     * Stores the cache in RAM if within limits or updates time stamp if already there
     * @param {string} hash
     * @param {Buffer} data
     * @return {boolean}
     * @private
     */
    _storeCacheInRAM(hash,data) {
        let now = (new Date()).getTime();                                                               //get current time

        //check if already there
        if (this._caches[hash]!==undefined) {                                                           //no need to check data match since hash would be different
            if (this._debug) console.log(`cache time updated: ${makeYellow}${hash}${makeNormal} to ${makeYellow}${now}${makeNormal}`);          //if debug add console notice of removal
            this._caches[hash][0] = now;                                                                //update last used stamp
            return true;                                                                                //return that it is in RAM
        }

        //stop processing if over the file size limit for RAM
        let size=data.length;                                                                           //get file size
        if (size > this._fileLimit) return false;                                                       //to big so return that it is not in RAM

        //free up space for file if necessary
        this._freeSpaceInRAM(size,now);

        //add file
        if (this._debug) console.log(`cache added: ${makeYellow}${hash}${makeNormal}`);
        this._current += size;                                                                          //add file size to current value
        this._caches[hash] = [now, data];                                                               //store time and data in cache

        return true;                                                                                    //return that it is in RAM
    }


    /**
     * If there is space it adds the data to the cache.
     * Either way it returns the hash
     * Multiple paths can be given to allow lookup from multiple names.  data is still only stored once
     * @param {Buffer}  data
     * @param {String|[String]}  paths
     * @param {boolean} waitForLongTermIfPutInRAM
     * @return {Promise<string>}
     */
    async put(data,paths=[],waitForLongTermIfPutInRAM=false) {
        return new Promise((resolve, reject) => {
            //quick error check.  If not long term and size is to big throw error
            if ((this._longterm===false)&&(data.length>this._fileLimit)) return reject(new Error(`File to large to fit in cache.\nPath: ${paths}\ndata: ${data.toString('hex')}`));

            //calculate the has of the data
            let hash=crypto.createHash('sha256').update(data).digest('hex');                            //get hash

            //return promise so we can control if it runs synchronously or asynchronously
            //if waitForLongTermIfPutInRAM is true then always runs asynchronously
            //if waitForLongTermIfPutInRAM is false then will run synchronously is it can fit in RAM and will not wait for long term calls
            let waiting=[];

            if (typeof paths==="string") paths=[paths];                                                 //make sure path is an array
            for (let path of paths) {
                if ((this._paths[path] === undefined) || (this._paths[path][1] !== hash)) {             //if path is set and path data not already stored
                    this._storePathInRAM(path, hash);                                                   //store the path in RAM
                    if (this._longterm !== false) waiting.push(this._longterm.writePath(path, hash));   //if long term is enabled store path in it
                }
            }

            //store in long term if set
            if (this._longterm !== false) {                                                             //if long term is enabled
                if ((this._caches[hash]===undefined)||(Buffer.compare(this._caches[hash][1],data)===0)) {                 //if not already in RAM(theory being if in RAM it must also be in long term so save the write)
                    waiting.push(this._longterm.writeCache(hash, data));                                //store the cache in long term
                }
            }

            //store in RAM if the file is within the file limit
            let inRAM=this._storeCacheInRAM(hash,data);

            //see if we should resolve immediately or wait for the waiting functions
            if ((!waitForLongTermIfPutInRAM) && (inRAM)) return resolve(hash);                          //in RAM and user does not want to wait for any pending long term
            Promise.all(waiting).then(()=>resolve(hash)).catch(reject);                                          //make sure all asynchronous tasks are done before returning
        });
    }

    /**
     * Returns a buffer if hash is known or throws an error if not known
     * @param {string}  hash
     * @return {Promise<Buffer>}
     */
    async getByHash(hash) {
        //see if we can pull from ram
        if (this._caches[hash]!==undefined) {
            let now=(new Date()).getTime();
            if (this._debug) console.log(`update cache time: ${makeYellow}${hash}${makeNormal} to ${makeYellow}${now}${makeNormal}`);                        //if debug add console notice of removal
            this._caches[hash][0]=now;                                                                  //update time
            return this._caches[hash][1];                                                               //return data
        }

        //check long term
        if (this._longterm!==false) {
            try {
                let data=await this._longterm.readCache(hash);                                          //gets the cache from long term if set
                this._storeCacheInRAM(hash,data);                                                       //re put data back in RAM
                return data;                                                                            //return the data
            } catch (_) {}
        }

        //file was not found so throw error
        throw new Error(`requested data could not be retrieved.  hash: ${hash}`);                        //if we got here then the hash was not stored
    }

    /**
     * Returns a buffer if hash is known or throws an error if not known
     * @param {string}  path
     * @return {Promise<Buffer>}
     */
    async getByPath(path) {
        //see if we can get path from RAM
        let hash;
        if (this._paths[path]!==undefined) {
            hash=this._paths[path][1];                                                                  //If path in ram then set
        }

        //check long term
        if ((hash===undefined)&&(this._longterm!==false)) {
            try {
                hash=await this._longterm.readPath(path);                                                     //gets the hash from long term if set
                this._storePathInRAM(path,hash);                                                        //restore in RAM since not there anymore
            } catch (_) {}
        }

        //handle error if path not found
        if (hash===undefined) throw new Error(`requested data could not be retrieved.  path: ${path}`);

        //get the requested data
        return this.getByHash(hash);
    }

}
module.exports=Cache;