# permacache



## Installation
``` bash
npm install permacache
```

## Usage
``` javascript
const Cache=require('permacache');
let cache=new Cache({
    longterm:   "tests/temp"
});
let hash=await cache.put(someBuffer,'optional_path');
console.log(await cache.getByHash(hash));
console.log(await cache.getByPath('optional_path'));
```

##### Warning S3 capabilities not yet tested